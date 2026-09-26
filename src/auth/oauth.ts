import { createHash } from 'node:crypto';
import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { z } from 'zod';
import { signApprovalRequest, verifyApprovalRequest } from './approval-token.ts';
import { renderConsentPage, renderErrorPage } from './consent.ts';
import { verifyPkceS256 } from './pkce.ts';
import { isAllowedRedirectUri, redirectUriMatches } from './redirects.ts';
import { ClientCapacityError, type ClientRecord, type OAuthStore } from './store.ts';
import type { AccessResult } from './access.ts';

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];
const SUPPORTED_RESPONSE_TYPES = ['code'];
const SUPPORTED_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;

export interface AuthInfo {
  clientId: string;
  subject: string;
  scopes: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthInfo;
  }
}

export interface AccessVerifier {
  verify(req: Request): Promise<AccessResult>;
}

export interface CreateOAuthRouterOptions {
  /** The server's own externally reachable base URL, no trailing slash, e.g. https://claudia.example.com */
  publicUrl: string;
  store: OAuthStore;
  access: AccessVerifier;
  signingKey: Buffer;
  now: () => Date;
  /** Additional redirect URIs to allow beyond Claude's hosted callbacks and loopback. */
  extraRedirectUris?: string[];
}

/**
 * `formActionOrigin` must be the origin of an already-validated redirect_uri: browsers apply
 * CSP form-action to the redirect that follows a form submission, so the approval page has to
 * allow the client's callback origin or the post-Approve redirect is silently blocked.
 */
function sendHtml(res: Response, status: number, html: string, formActionOrigin?: string): void {
  const formAction = formActionOrigin ? `'self' ${formActionOrigin}` : "'self'";
  res
    .status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}`,
    )
    .set('X-Frame-Options', 'DENY')
    .send(html);
}

function sendErrorPage(
  res: Response,
  status: 400 | 403 | 503,
  title: string,
  message: string,
): void {
  sendHtml(res, status, renderErrorPage(title, message));
}

function redirectWithError(
  res: Response,
  redirectUri: string,
  params: { error: string; error_description?: string; state?: string },
): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', params.error);
  if (params.error_description) url.searchParams.set('error_description', params.error_description);
  if (params.state !== undefined) url.searchParams.set('state', params.state);
  res.redirect(302, url.toString());
}

function sendTokenError(
  res: Response,
  status: number,
  error: string,
  description: string,
  isClientAuthFailure = false,
): void {
  if (isClientAuthFailure) {
    res.set('WWW-Authenticate', 'Basic');
  }
  res.status(status).json({ error, error_description: description });
}

const RegisterBody = z
  .object({
    redirect_uris: z.array(z.string()).min(1),
    token_endpoint_auth_method: z.enum(SUPPORTED_AUTH_METHODS).optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    client_name: z.string().optional(),
    scope: z.string().optional(),
  })
  .loose();

export function createOAuthRouter(opts: CreateOAuthRouterOptions): Router {
  const { publicUrl, store, access, signingKey, now } = opts;
  const extraRedirectUris = opts.extraRedirectUris ?? [];
  const mcpResource = `${publicUrl}/mcp`;
  const router = Router();

  function accessErrorPage(res: Response, result: Extract<AccessResult, { ok: false }>): void {
    const title = result.status === 503 ? 'Not configured' : 'Sign-in required';
    sendErrorPage(res, result.status, title, result.reason);
  }

  // --- RFC 8414: authorization server metadata -----------------------------------------------
  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      revocation_endpoint: `${publicUrl}/oauth/revoke`,
      response_types_supported: SUPPORTED_RESPONSE_TYPES,
      grant_types_supported: SUPPORTED_GRANT_TYPES,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: SUPPORTED_AUTH_METHODS,
      scopes_supported: ['claudia'],
    });
  });

  // --- RFC 9728: protected resource metadata --------------------------------------------------
  const protectedResourceMetadata = () => ({
    resource: mcpResource,
    authorization_servers: [publicUrl],
    scopes_supported: ['claudia'],
    bearer_methods_supported: ['header'],
  });
  router.get('/.well-known/oauth-protected-resource', (_req, res) =>
    res.json(protectedResourceMetadata()),
  );
  router.get('/.well-known/oauth-protected-resource/mcp', (_req, res) =>
    res.json(protectedResourceMetadata()),
  );

  // --- RFC 7591: dynamic client registration --------------------------------------------------
  router.post('/oauth/register', express.json({ limit: '100kb' }), (req, res) => {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_client_metadata', error_description: 'Invalid client metadata.' });
      return;
    }
    const body = parsed.data;

    for (const uri of body.redirect_uris) {
      if (!isAllowedRedirectUri(uri, extraRedirectUris)) {
        res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: `Redirect URI not allowed: ${uri}`,
        });
        return;
      }
    }

    const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!grantTypes.every((g) => SUPPORTED_GRANT_TYPES.includes(g))) {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'Unsupported grant type requested.',
      });
      return;
    }

    const responseTypes = body.response_types ?? ['code'];
    if (!responseTypes.every((t) => SUPPORTED_RESPONSE_TYPES.includes(t))) {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'Unsupported response type requested.',
      });
      return;
    }

    let registered;
    try {
      registered = store.registerClient({
        redirectUris: body.redirect_uris,
        tokenEndpointAuthMethod: body.token_endpoint_auth_method,
        grantTypes,
        responseTypes,
        clientName: body.client_name,
        scope: body.scope,
      });
    } catch (error) {
      if (error instanceof ClientCapacityError) {
        res
          .status(429)
          .json({ error: 'invalid_client_metadata', error_description: error.message });
        return;
      }
      throw error;
    }

    res.status(201).json({
      client_id: registered.clientId,
      client_secret: registered.clientSecret,
      client_id_issued_at: registered.clientIdIssuedAt,
      client_secret_expires_at: registered.clientSecret !== undefined ? 0 : undefined,
      token_endpoint_auth_method: registered.tokenEndpointAuthMethod,
      redirect_uris: registered.redirectUris,
      grant_types: registered.grantTypes,
      response_types: registered.responseTypes,
      client_name: registered.clientName,
      scope: registered.scope,
    });
  });

  // --- GET /oauth/authorize --------------------------------------------------------------------
  router.get('/oauth/authorize', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const query = req.query as Record<string, unknown>;
      const stringParam = (name: string): string | undefined => {
        const value = query[name];
        return typeof value === 'string' ? value : undefined;
      };

      const clientId = stringParam('client_id');
      if (!clientId) {
        sendErrorPage(res, 400, 'Invalid request', 'Missing client_id.');
        return;
      }

      const client = store.getClient(clientId);
      if (!client) {
        sendErrorPage(res, 400, 'Unknown client', 'This client is not registered with Claudia.');
        return;
      }

      const redirectUriParam = stringParam('redirect_uri');
      if (
        !redirectUriParam ||
        !client.redirectUris.some((r) => redirectUriMatches(redirectUriParam, r))
      ) {
        sendErrorPage(
          res,
          400,
          'Invalid redirect',
          'redirect_uri is missing or not registered for this client.',
        );
        return;
      }
      const redirectUri = redirectUriParam;
      const state = stringParam('state');

      const fail = (error: string, description: string): void =>
        redirectWithError(res, redirectUri, { error, error_description: description, state });

      if (stringParam('response_type') !== 'code') {
        fail('unsupported_response_type', 'Only response_type=code is supported.');
        return;
      }

      const codeChallenge = stringParam('code_challenge');
      if (!codeChallenge) {
        fail('invalid_request', 'code_challenge is required.');
        return;
      }
      if (stringParam('code_challenge_method') !== 'S256') {
        fail('invalid_request', 'code_challenge_method must be S256.');
        return;
      }

      const resourceParam = stringParam('resource');
      if (resourceParam && resourceParam !== mcpResource && resourceParam !== publicUrl) {
        fail('invalid_target', 'resource must be the Claudia MCP URL.');
        return;
      }
      const resource = resourceParam ?? mcpResource;

      // Scope is informational here: unknown scopes are ignored rather than rejected, and
      // Claudia only ever grants its single 'claudia' scope.
      const scope = 'claudia';

      const accessResult = await access.verify(req);
      if (!accessResult.ok) {
        accessErrorPage(res, accessResult);
        return;
      }

      const expiresAt = now().getTime() + APPROVAL_TTL_MS;
      const signedRequest = signApprovalRequest(signingKey, {
        clientId,
        redirectUri,
        codeChallenge,
        scope,
        resource,
        state,
        subject: accessResult.email,
        expiresAt,
      });

      sendHtml(
        res,
        200,
        renderConsentPage({
          clientName: client.clientName ?? clientId,
          redirectHost: safeHost(redirectUri),
          email: accessResult.email,
          approveAction: `${publicUrl}/oauth/approve`,
          signedRequest,
        }),
        new URL(redirectUri).origin,
      );
    })().catch(next);
  });

  // --- POST /oauth/approve -----------------------------------------------------------------
  router.post(
    '/oauth/approve',
    express.urlencoded({ extended: false, limit: '100kb' }),
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const body = req.body as Record<string, unknown>;
        const requestToken = typeof body.request === 'string' ? body.request : undefined;
        if (!requestToken) {
          sendErrorPage(res, 400, 'Invalid request', 'Missing approval request.');
          return;
        }

        const approvalRequest = verifyApprovalRequest(signingKey, requestToken, now);
        if (!approvalRequest) {
          sendErrorPage(
            res,
            400,
            'Expired or invalid request',
            'This approval link has expired or was tampered with. Please try connecting again.',
          );
          return;
        }

        const accessResult = await access.verify(req);
        if (!accessResult.ok) {
          accessErrorPage(res, accessResult);
          return;
        }
        if (accessResult.email.toLowerCase() !== approvalRequest.subject.toLowerCase()) {
          sendErrorPage(
            res,
            403,
            'Sign-in mismatch',
            'The signed-in identity changed. Please try connecting again.',
          );
          return;
        }

        // Single-use: a signed approval request (the hidden `request` field) must never mint two
        // authorization codes, whether from a double form submit, a replayed request, or a
        // resubmission after the browser goes back. The hash is remembered until the request's
        // own expiry, matching approval-token.ts's TTL.
        const requestHash = createHash('sha256').update(requestToken).digest('hex');
        if (!store.consumeApprovalOnce(requestHash, approvalRequest.expiresAt)) {
          sendErrorPage(
            res,
            400,
            'Already used',
            'This approval link has already been used. Please try connecting again.',
          );
          return;
        }

        const decision = typeof body.decision === 'string' ? body.decision : undefined;
        if (decision !== 'approve') {
          redirectWithError(res, approvalRequest.redirectUri, {
            error: 'access_denied',
            error_description: 'The request was denied.',
            state: approvalRequest.state,
          });
          return;
        }

        const { code } = store.createCode({
          clientId: approvalRequest.clientId,
          redirectUri: approvalRequest.redirectUri,
          codeChallenge: approvalRequest.codeChallenge,
          scope: approvalRequest.scope,
          resource: approvalRequest.resource,
          subject: approvalRequest.subject,
        });

        const url = new URL(approvalRequest.redirectUri);
        url.searchParams.set('code', code);
        if (approvalRequest.state !== undefined)
          url.searchParams.set('state', approvalRequest.state);
        url.searchParams.set('iss', publicUrl);
        res.redirect(302, url.toString());
      })().catch(next);
    },
  );

  // --- POST /oauth/token -------------------------------------------------------------------
  router.post(
    '/oauth/token',
    express.urlencoded({ extended: false, limit: '100kb' }),
    (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      res.set('Pragma', 'no-cache');

      if (!req.is('application/x-www-form-urlencoded')) {
        sendTokenError(
          res,
          400,
          'invalid_request',
          'Content-Type must be application/x-www-form-urlencoded.',
        );
        return;
      }

      const body = req.body as Record<string, string | undefined>;
      const grantType = body.grant_type;

      if (grantType === 'authorization_code') {
        handleAuthorizationCodeGrant(req, res, body);
        return;
      }
      if (grantType === 'refresh_token') {
        handleRefreshGrant(req, res, body);
        return;
      }

      sendTokenError(
        res,
        400,
        'unsupported_grant_type',
        'Supported grant types: authorization_code, refresh_token.',
      );
    },
  );

  type ClientAuthResult = { ok: true; client: ClientRecord } | { ok: false };

  function authenticateClient(
    req: Request,
    body: Record<string, string | undefined>,
  ): ClientAuthResult {
    let clientId = body.client_id;
    let providedSecret: string | undefined = body.client_secret;

    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8');
        const separatorIndex = decoded.indexOf(':');
        if (separatorIndex < 0) return { ok: false };
        clientId = decodeURIComponent(decoded.slice(0, separatorIndex));
        providedSecret = decodeURIComponent(decoded.slice(separatorIndex + 1));
      } catch {
        return { ok: false };
      }
    }

    if (!clientId) return { ok: false };
    const client = store.getClient(clientId);
    if (!client) return { ok: false };

    if (client.tokenEndpointAuthMethod === 'none') {
      return { ok: true, client };
    }

    if (!providedSecret || !store.verifyClientSecret(client, providedSecret)) {
      return { ok: false };
    }
    return { ok: true, client };
  }

  function handleAuthorizationCodeGrant(
    req: Request,
    res: Response,
    body: Record<string, string | undefined>,
  ): void {
    const auth = authenticateClient(req, body);
    if (!auth.ok) {
      sendTokenError(res, 401, 'invalid_client', 'Client authentication failed.', true);
      return;
    }

    const { code, redirect_uri: redirectUri, code_verifier: codeVerifier } = body;
    if (!code || !redirectUri || !codeVerifier) {
      sendTokenError(
        res,
        400,
        'invalid_request',
        'code, redirect_uri and code_verifier are required.',
      );
      return;
    }

    const record = store.consumeCode(code);
    if (!record) {
      sendTokenError(
        res,
        400,
        'invalid_grant',
        'The authorization code is invalid, expired or already used.',
      );
      return;
    }

    if (record.clientId !== auth.client.clientId) {
      sendTokenError(
        res,
        400,
        'invalid_grant',
        'The authorization code was not issued to this client.',
      );
      return;
    }
    if (record.redirectUri !== redirectUri) {
      sendTokenError(
        res,
        400,
        'invalid_grant',
        'redirect_uri does not match the authorization request.',
      );
      return;
    }
    if (!verifyPkceS256(codeVerifier, record.codeChallenge)) {
      sendTokenError(res, 400, 'invalid_grant', 'code_verifier does not match code_challenge.');
      return;
    }

    const resourceParam = body.resource;
    if (resourceParam && record.resource && resourceParam !== record.resource) {
      sendTokenError(
        res,
        400,
        'invalid_target',
        'resource does not match the authorization request.',
      );
      return;
    }

    const tokens = store.issueTokens(
      auth.client.clientId,
      record.subject,
      record.scope,
      record.resource,
    );
    res.status(200).json({
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: tokens.scope,
    });
  }

  function handleRefreshGrant(
    req: Request,
    res: Response,
    body: Record<string, string | undefined>,
  ): void {
    const auth = authenticateClient(req, body);
    if (!auth.ok) {
      sendTokenError(res, 401, 'invalid_client', 'Client authentication failed.', true);
      return;
    }

    const refreshToken = body.refresh_token;
    if (!refreshToken) {
      sendTokenError(res, 400, 'invalid_request', 'refresh_token is required.');
      return;
    }

    const result = store.refreshTokens(refreshToken, auth.client.clientId, body.resource ?? null);
    if (!result.ok) {
      sendTokenError(
        res,
        400,
        'invalid_grant',
        'The refresh token is invalid, expired or already used.',
      );
      return;
    }

    res.status(200).json({
      access_token: result.tokens.accessToken,
      token_type: result.tokens.tokenType,
      expires_in: result.tokens.expiresIn,
      refresh_token: result.tokens.refreshToken,
      scope: result.tokens.scope,
    });
  }

  // --- RFC 7009: revocation ------------------------------------------------------------------
  router.post(
    '/oauth/revoke',
    express.urlencoded({ extended: false, limit: '100kb' }),
    (req: Request, res: Response) => {
      const body = req.body as Record<string, string | undefined>;
      if (body.token) {
        store.revokeToken(body.token);
      }
      res.status(200).json({});
    },
  );

  return router;
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export interface RequireBearerOptions {
  store: OAuthStore;
  publicUrl: string;
}

/** Express middleware guarding /mcp: verifies the bearer access token and sets req.auth. */
export function requireBearer(opts: RequireBearerOptions): RequestHandler {
  const resourceMetadataUrl = `${opts.publicUrl}/.well-known/oauth-protected-resource/mcp`;

  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : undefined;

    if (!token) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`);
      res.status(401).json({ error: 'invalid_request' });
      return;
    }

    const info = opts.store.verifyAccessToken(token);
    if (!info) {
      res.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`,
      );
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    req.auth = {
      clientId: info.clientId,
      subject: info.subject,
      scopes: info.scope.split(' ').filter((s) => s.length > 0),
    };
    next();
  };
}
