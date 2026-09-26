import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccessVerifier } from '../../src/auth/access.ts';
import { createOAuthRouter, requireBearer } from '../../src/auth/oauth.ts';
import { createOAuthStore, type OAuthStore } from '../../src/auth/store.ts';
import { createHttpApp } from '../../src/http/app.ts';
import { createAccessKeyFixture, type AccessKeyFixture } from '../helpers/access-keys.ts';

const TEAM_DOMAIN = 'myteam.cloudflareaccess.com';
const AUDIENCE = 'claudia-test-audience';
const OWNER_EMAIL = 'aroop@example.com';
const ISSUER = `https://${TEAM_DOMAIN}`;

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('failed to reserve a port')));
      }
    });
  });
}

function extractSignedRequest(html: string): string {
  const match = /name="request" value="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error(`could not find signed request field in:\n${html}`);
  return match[1];
}

describe('OAuth authorization server (integration)', () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const now = () => new Date(clock);

  let db: DatabaseSync;
  let store: OAuthStore;
  let accessKeys: AccessKeyFixture;
  let server: Server;
  let publicUrl: string;

  beforeAll(async () => {
    accessKeys = await createAccessKeyFixture();

    db = new DatabaseSync(':memory:');
    store = createOAuthStore(db, { now });
    store.migrate();

    const access = createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      ownerEmail: OWNER_EMAIL,
      jwks: accessKeys.jwks,
    });

    const signingKey = Buffer.from('integration-test-signing-key-do-not-use-in-prod');

    const port = await reservePort();
    publicUrl = `http://127.0.0.1:${port}`;

    const oauthRouter = createOAuthRouter({ publicUrl, store, access, signingKey, now });
    const bearer = requireBearer({ store, publicUrl });
    const app = createHttpApp({ publicUrl, oauthRouter, bearer, health: () => ({ status: 'ok' }) });

    await new Promise<void>((resolve) => {
      server = app.listen(port, '127.0.0.1', () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
  });

  function accessJwt(overrides: Partial<Parameters<AccessKeyFixture['signAccessJwt']>[0]> = {}) {
    return accessKeys.signAccessJwt({
      email: OWNER_EMAIL,
      aud: AUDIENCE,
      iss: ISSUER,
      ...overrides,
    });
  }

  it('rejects an unauthenticated /mcp call with 401 and a resource_metadata challenge', async () => {
    const res = await fetch(`${publicUrl}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
    const header = res.headers.get('www-authenticate');
    expect(header).toContain(
      `resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(header).not.toContain('error='); // no token was supplied
  });

  it('serves protected resource metadata at the discovered URL', async () => {
    const res = await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(`${publicUrl}/mcp`);
    expect(body.authorization_servers).toEqual([publicUrl]);
  });

  it('serves protected resource metadata at the fallback (non-mcp-suffixed) URL too', async () => {
    const res = await fetch(`${publicUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
  });

  it('serves authorization server metadata', async () => {
    const res = await fetch(`${publicUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      revocation_endpoint: `${publicUrl}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['claudia'],
    });
  });

  it('registers a client using the claude.ai hosted callback', async () => {
    const res = await fetch(`${publicUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        client_name: 'Claude',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toEqual(expect.any(String));
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('rejects registration of a disallowed redirect URI', async () => {
    const res = await fetch(`${publicUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example.com/callback'] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_redirect_uri');
  });

  describe('the full authorization_code + refresh flow, using a loopback (Claude Code style) client', () => {
    const redirectUri = 'http://127.0.0.1:54999/callback';
    const verifier = 'test-code-verifier-1234567890-abcdefghijklmnopqrstuvwxyz';
    const challenge = pkceChallenge(verifier);
    let clientId: string;

    async function authorizeAndApprove(
      state: string,
    ): Promise<{ code: string; state: string | null; iss: string | null }> {
      const authorizeUrl = new URL(`${publicUrl}/oauth/authorize`);
      authorizeUrl.searchParams.set('client_id', clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('resource', `${publicUrl}/mcp`);
      authorizeUrl.searchParams.set('state', state);

      const jwt = await accessJwt();
      const authorizeRes = await fetch(authorizeUrl, {
        headers: { 'cf-access-jwt-assertion': jwt },
      });
      expect(authorizeRes.status).toBe(200);
      const html = await authorizeRes.text();
      expect(html).toContain('Approve');
      const signedRequest = extractSignedRequest(html);

      const approveRes = await fetch(`${publicUrl}/oauth/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cf-access-jwt-assertion': jwt,
        },
        body: new URLSearchParams({ request: signedRequest, decision: 'approve' }).toString(),
      });
      expect(approveRes.status).toBe(302);
      const location = new URL(approveRes.headers.get('location')!);
      const code = location.searchParams.get('code');
      expect(code).toBeTruthy();
      return {
        code: code!,
        state: location.searchParams.get('state'),
        iss: location.searchParams.get('iss'),
      };
    }

    beforeAll(async () => {
      const res = await fetch(`${publicUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Claude Code' }),
      });
      const body = (await res.json()) as { client_id: string };
      clientId = body.client_id;
    });

    it('shows the approval page and approving redirects with code, state and iss', async () => {
      const { state, iss } = await authorizeAndApprove('state-abc-123');
      expect(state).toBe('state-abc-123');
      expect(iss).toBe(publicUrl);
    });

    it("lets the approval form's redirect reach the client's callback origin (CSP form-action)", async () => {
      const authorizeUrl = new URL(`${publicUrl}/oauth/authorize`);
      authorizeUrl.searchParams.set('client_id', clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      const res = await fetch(authorizeUrl, {
        headers: { 'cf-access-jwt-assertion': await accessJwt() },
      });
      expect(res.status).toBe(200);
      const csp = res.headers.get('content-security-policy') ?? '';
      // Browsers enforce form-action on the redirect after submit, so the callback origin must be listed.
      expect(csp).toContain(`form-action 'self' ${new URL(redirectUri).origin}`);
      expect(csp).toContain("default-src 'none'");
    });

    it('rejects authorize with no Access assertion at all (403)', async () => {
      const authorizeUrl = new URL(`${publicUrl}/oauth/authorize`);
      authorizeUrl.searchParams.set('client_id', clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');

      const res = await fetch(authorizeUrl);
      expect(res.status).toBe(403);
    });

    it('rejects a tampered approval form with 400', async () => {
      const authorizeUrl = new URL(`${publicUrl}/oauth/authorize`);
      authorizeUrl.searchParams.set('client_id', clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');

      const jwt = await accessJwt();
      const authorizeRes = await fetch(authorizeUrl, {
        headers: { 'cf-access-jwt-assertion': jwt },
      });
      const html = await authorizeRes.text();
      const signedRequest = extractSignedRequest(html);
      const tampered =
        signedRequest.slice(0, -2) +
        (signedRequest.at(-2) === 'A' ? 'B' : 'A') +
        signedRequest.at(-1);

      const approveRes = await fetch(`${publicUrl}/oauth/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cf-access-jwt-assertion': jwt,
        },
        body: new URLSearchParams({ request: tampered, decision: 'approve' }).toString(),
      });
      expect(approveRes.status).toBe(400);
    });

    it('exchanges the code for tokens over form-urlencoded POST', async () => {
      const { code } = await authorizeAndApprove('exchange-state');

      const tokenRes = await fetch(`${publicUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.headers.get('cache-control')).toContain('no-store');
      const body = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
        scope: string;
      };
      expect(body.token_type).toBe('Bearer');
      expect(body.expires_in).toBe(3600);
      expect(body.scope).toBe('claudia');
      expect(body.access_token).toEqual(expect.any(String));
      expect(body.refresh_token).toEqual(expect.any(String));

      // Proves auth passed: the /mcp stub (no mcp handler configured) answers 501, not 401/403.
      const mcpRes = await fetch(`${publicUrl}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      expect(mcpRes.status).toBe(501);

      // Replaying the same code must fail.
      const replayRes = await fetch(`${publicUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      });
      expect(replayRes.status).toBe(400);
      expect(((await replayRes.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('rejects the wrong code_verifier with invalid_grant', async () => {
      const { code } = await authorizeAndApprove('wrong-verifier-state');

      const tokenRes = await fetch(`${publicUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: 'totally-the-wrong-verifier-value-zzzzzzzzzzzzzzzzzzzz',
        }).toString(),
      });
      expect(tokenRes.status).toBe(400);
      expect(((await tokenRes.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('rejects a JSON token request with 400 invalid_request', async () => {
      const tokenRes = await fetch(`${publicUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code: 'x' }),
      });
      expect(tokenRes.status).toBe(400);
      expect(((await tokenRes.json()) as { error: string }).error).toBe('invalid_request');
    });

    it('rotates refresh tokens, rejects reuse and revokes the family on reuse', async () => {
      const { code } = await authorizeAndApprove('refresh-flow-state');
      const initialTokenRes = await fetch(`${publicUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      });
      const initial = (await initialTokenRes.json()) as {
        access_token: string;
        refresh_token: string;
      };

      const rotateOnce = async (refreshToken: string) =>
        fetch(`${publicUrl}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
          }).toString(),
        });

      const rotatedRes = await rotateOnce(initial.refresh_token);
      expect(rotatedRes.status).toBe(200);
      const rotated = (await rotatedRes.json()) as { access_token: string; refresh_token: string };
      expect(rotated.access_token).not.toBe(initial.access_token);
      expect(rotated.refresh_token).not.toBe(initial.refresh_token);

      // The new access token works.
      const mcpRes = await fetch(`${publicUrl}/mcp`, {
        headers: { authorization: `Bearer ${rotated.access_token}` },
      });
      expect(mcpRes.status).toBe(501);

      // Reusing the old (already-rotated) refresh token is rejected...
      const reuseRes = await rotateOnce(initial.refresh_token);
      expect(reuseRes.status).toBe(400);
      expect(((await reuseRes.json()) as { error: string }).error).toBe('invalid_grant');

      // ...and revokes the whole family, so even the token minted by the legitimate rotation is now dead.
      const mcpAfterReuseRes = await fetch(`${publicUrl}/mcp`, {
        headers: { authorization: `Bearer ${rotated.access_token}` },
      });
      expect(mcpAfterReuseRes.status).toBe(401);
    });
  });

  describe('expired access tokens (using the store directly, per the no-bypass testing rule)', () => {
    it('is rejected once the fake clock advances past the 1 hour TTL', async () => {
      const clientRes = await fetch(`${publicUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:1/callback'] }),
      });
      const { client_id: clientId } = (await clientRes.json()) as { client_id: string };

      const tokens = store.issueTokens(clientId, OWNER_EMAIL, 'claudia', null);

      const beforeRes = await fetch(`${publicUrl}/mcp`, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      expect(beforeRes.status).toBe(501);

      const savedClock = clock;
      clock += 60 * 60 * 1000 + 1;
      try {
        const afterRes = await fetch(`${publicUrl}/mcp`, {
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        });
        expect(afterRes.status).toBe(401);
        expect(afterRes.headers.get('www-authenticate')).toContain('error="invalid_token"');
      } finally {
        clock = savedClock;
      }
    });
  });

  it('revoke always returns 200, even for an unknown token', async () => {
    const res = await fetch(`${publicUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'never-issued' }).toString(),
    });
    expect(res.status).toBe(200);
  });
});
