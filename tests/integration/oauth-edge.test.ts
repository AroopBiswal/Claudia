import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccessVerifier } from '../../src/auth/access.ts';
import { createOAuthRouter, requireBearer } from '../../src/auth/oauth.ts';
import { createOAuthStore, type OAuthStore } from '../../src/auth/store.ts';
import { createHttpApp } from '../../src/http/app.ts';
import { createAccessKeyFixture, type AccessKeyFixture } from '../helpers/access-keys.ts';

const TEAM_DOMAIN = 'myteam.cloudflareaccess.com';
const AUDIENCE = 'claudia-test-audience';
const OWNER_EMAIL = 'aroop@example.com';
const OTHER_EMAIL = 'someone-else@example.com';
const ISSUER = `https://${TEAM_DOMAIN}`;
const SIGNING_KEY = Buffer.from('integration-edge-test-signing-key-do-not-use-in-prod');

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

interface TestServer {
  db: DatabaseSync;
  store: OAuthStore;
  server: Server;
  publicUrl: string;
}

async function startServer(accessKeys: AccessKeyFixture): Promise<TestServer> {
  const db = new DatabaseSync(':memory:');
  const store = createOAuthStore(db, { now: () => new Date() });
  store.migrate();

  const access = createAccessVerifier({
    teamDomain: TEAM_DOMAIN,
    audience: AUDIENCE,
    ownerEmail: OWNER_EMAIL,
    jwks: accessKeys.jwks,
  });

  const port = await reservePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  const oauthRouter = createOAuthRouter({
    publicUrl,
    store,
    access,
    signingKey: SIGNING_KEY,
    now: () => new Date(),
  });
  const bearer = requireBearer({ store, publicUrl });
  const app = createHttpApp({ publicUrl, oauthRouter, bearer, health: () => ({ status: 'ok' }) });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });

  return { db, store, server, publicUrl };
}

async function stopServer(ts: TestServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ts.server.close((err) => (err ? reject(err) : resolve()));
  });
  ts.db.close();
}

describe('OAuth edge cases (integration, real HTTP)', () => {
  let accessKeys: AccessKeyFixture;

  beforeAll(async () => {
    accessKeys = await createAccessKeyFixture();
  });

  function accessJwt(overrides: Partial<Parameters<AccessKeyFixture['signAccessJwt']>[0]> = {}) {
    return accessKeys.signAccessJwt({
      email: OWNER_EMAIL,
      aud: AUDIENCE,
      iss: ISSUER,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------------------------
  describe('dynamic client registration: redirect_uri validation', () => {
    let ts: TestServer;
    beforeAll(async () => {
      ts = await startServer(accessKeys);
    });
    afterAll(() => stopServer(ts));

    async function register(redirectUris: string[]) {
      return fetch(`${ts.publicUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: redirectUris }),
      });
    }

    it('rejects a redirect_uri with a fragment', async () => {
      const res = await register(['http://127.0.0.1:5000/callback#frag']);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    });

    it('rejects a redirect_uri with userinfo (user:pass@host)', async () => {
      const res = await register(['http://attacker:pw@127.0.0.1:5000/callback']);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    });

    it('rejects a redirect_uri impersonating Claude on a foreign host (http://evil.com/api/mcp/auth_callback)', async () => {
      const res = await register(['http://evil.com/api/mcp/auth_callback']);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    });

    it('rejects a subdomain-confusion redirect_uri (https://claude.ai.evil.com/...)', async () => {
      const res = await register(['https://claude.ai.evil.com/api/mcp/auth_callback']);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    });

    it('accepts a loopback IPv6 ([::1]) redirect_uri', async () => {
      const res = await register(['http://[::1]:5000/callback']);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { redirect_uris: string[] };
      expect(body.redirect_uris).toEqual(['http://[::1]:5000/callback']);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('authorize with a registered loopback client: IPv6 port-matching and path mismatch', () => {
    let ts: TestServer;
    let clientId: string;
    const registeredUri = 'http://[::1]:5000/callback';
    const verifier = 'edge-test-verifier-1234567890-abcdefghijklmnopqrstuvwxyz';
    const challenge = pkceChallenge(verifier);

    beforeAll(async () => {
      ts = await startServer(accessKeys);
      const res = await fetch(`${ts.publicUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [registeredUri] }),
      });
      const body = (await res.json()) as { client_id: string };
      clientId = body.client_id;
    });
    afterAll(() => stopServer(ts));

    function authorizeUrl(redirectUri: string, state = 'state-1'): URL {
      const url = new URL(`${ts.publicUrl}/oauth/authorize`);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      return url;
    }

    it('matches the registered IPv6 loopback URI when only the port differs', async () => {
      const jwt = await accessJwt();
      const res = await fetch(authorizeUrl('http://[::1]:9999/callback'), {
        headers: { 'cf-access-jwt-assertion': jwt },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Approve');
    });

    it('rejects the same registered host/port when the path differs', async () => {
      const jwt = await accessJwt();
      const res = await fetch(authorizeUrl('http://[::1]:5000/other-path'), {
        headers: { 'cf-access-jwt-assertion': jwt },
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    });

    it('never redirects for an unregistered client_id', async () => {
      const url = new URL(`${ts.publicUrl}/oauth/authorize`);
      url.searchParams.set('client_id', 'not-a-real-client-id');
      url.searchParams.set('redirect_uri', registeredUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');

      const jwt = await accessJwt();
      const res = await fetch(url, {
        headers: { 'cf-access-jwt-assertion': jwt },
        redirect: 'manual',
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('state is echoed exactly, including special characters', () => {
    let ts: TestServer;
    let clientId: string;
    const redirectUri = 'http://127.0.0.1:6000/callback';
    const verifier = 'state-echo-verifier-1234567890-abcdefghijklmnopqrstuvwxyz';
    const challenge = pkceChallenge(verifier);

    beforeAll(async () => {
      ts = await startServer(accessKeys);
      const res = await fetch(`${ts.publicUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      });
      const body = (await res.json()) as { client_id: string };
      clientId = body.client_id;
    });
    afterAll(() => stopServer(ts));

    it('round-trips a state value with spaces, symbols and unicode', async () => {
      const weirdState = 'weird state !@#$%^&*()_+ 你好 <script>alert(1)</script> = &';

      const authorizeUrlObj = new URL(`${ts.publicUrl}/oauth/authorize`);
      authorizeUrlObj.searchParams.set('client_id', clientId);
      authorizeUrlObj.searchParams.set('redirect_uri', redirectUri);
      authorizeUrlObj.searchParams.set('response_type', 'code');
      authorizeUrlObj.searchParams.set('code_challenge', challenge);
      authorizeUrlObj.searchParams.set('code_challenge_method', 'S256');
      authorizeUrlObj.searchParams.set('state', weirdState);

      const jwt = await accessJwt();
      const authorizeRes = await fetch(authorizeUrlObj, {
        headers: { 'cf-access-jwt-assertion': jwt },
      });
      const html = await authorizeRes.text();
      const signedRequest = extractSignedRequest(html);

      const approveRes = await fetch(`${ts.publicUrl}/oauth/approve`, {
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
      expect(location.searchParams.get('state')).toBe(weirdState);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('approve: identity mismatch and single-use replay protection', () => {
    let ts: TestServer;
    let clientId: string;
    const redirectUri = 'http://127.0.0.1:7000/callback';
    const verifier = 'approve-edge-verifier-1234567890-abcdefghijklmnopqrstuvwxyz';
    const challenge = pkceChallenge(verifier);

    beforeAll(async () => {
      ts = await startServer(accessKeys);
      const res = await fetch(`${ts.publicUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      });
      const body = (await res.json()) as { client_id: string };
      clientId = body.client_id;
    });
    afterAll(() => stopServer(ts));

    async function authorize(state: string): Promise<string> {
      const url = new URL(`${ts.publicUrl}/oauth/authorize`);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      const jwt = await accessJwt();
      const res = await fetch(url, { headers: { 'cf-access-jwt-assertion': jwt } });
      return extractSignedRequest(await res.text());
    }

    it('rejects approval when the signed-in Access identity does not match the request subject', async () => {
      const signedRequest = await authorize('mismatch-state');
      const otherJwt = await accessJwt({ email: OTHER_EMAIL });

      const res = await fetch(`${ts.publicUrl}/oauth/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cf-access-jwt-assertion': otherJwt,
        },
        body: new URLSearchParams({ request: signedRequest, decision: 'approve' }).toString(),
      });
      expect(res.status).toBe(403);
    });

    it('mints exactly one code from a signed approval request: replaying it does not mint a second', async () => {
      const signedRequest = await authorize('replay-state');
      const jwt = await accessJwt();

      const firstRes = await fetch(`${ts.publicUrl}/oauth/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cf-access-jwt-assertion': jwt,
        },
        body: new URLSearchParams({ request: signedRequest, decision: 'approve' }).toString(),
      });
      expect(firstRes.status).toBe(302);
      const firstLocation = new URL(firstRes.headers.get('location')!);
      const firstCode = firstLocation.searchParams.get('code');
      expect(firstCode).toBeTruthy();

      // Replay the exact same signed request (e.g. a double form submit, or the browser
      // resubmitting on "back"). It must not mint a second authorization code.
      const secondRes = await fetch(`${ts.publicUrl}/oauth/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cf-access-jwt-assertion': jwt,
        },
        body: new URLSearchParams({ request: signedRequest, decision: 'approve' }).toString(),
      });
      expect(secondRes.status).not.toBe(302);
      expect(secondRes.headers.get('location')).toBeNull();

      // The first code minted is still the only valid one: exchanging it works exactly once.
      const tokenRes = await fetch(`${ts.publicUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: firstCode!,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('token endpoint: client authentication and cross-client refresh', () => {
    let ts: TestServer;
    const redirectUri = 'http://127.0.0.1:8000/callback';
    const verifier = 'token-edge-verifier-1234567890-abcdefghijklmnopqrstuvwxyz';
    const challenge = pkceChallenge(verifier);

    beforeAll(async () => {
      ts = await startServer(accessKeys);
    });
    afterAll(() => stopServer(ts));

    async function registerConfidentialClient(): Promise<{
      clientId: string;
      clientSecret: string;
    }> {
      const res = await fetch(`${ts.publicUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'client_secret_basic',
        }),
      });
      const body = (await res.json()) as { client_id: string; client_secret: string };
      return { clientId: body.client_id, clientSecret: body.client_secret };
    }

    async function authorizeAndApprove(clientId: string, state: string): Promise<string> {
      const url = new URL(`${ts.publicUrl}/oauth/authorize`);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      const jwt = await accessJwt();
      const authorizeRes = await fetch(url, { headers: { 'cf-access-jwt-assertion': jwt } });
      const signedRequest = extractSignedRequest(await authorizeRes.text());

      const approveRes = await fetch(`${ts.publicUrl}/oauth/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cf-access-jwt-assertion': jwt,
        },
        body: new URLSearchParams({ request: signedRequest, decision: 'approve' }).toString(),
      });
      const location = new URL(approveRes.headers.get('location')!);
      return location.searchParams.get('code')!;
    }

    it('rejects client_secret_basic with the wrong secret: 401 invalid_client', async () => {
      const { clientId } = await registerConfidentialClient();
      const code = await authorizeAndApprove(clientId, 'basic-wrong-secret');

      const basicAuth = Buffer.from(`${clientId}:totally-the-wrong-secret`).toString('base64');
      const res = await fetch(`${ts.publicUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Basic');
      expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
    });

    it('accepts client_secret_basic with the correct secret', async () => {
      const { clientId, clientSecret } = await registerConfidentialClient();
      const code = await authorizeAndApprove(clientId, 'basic-correct-secret');

      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const res = await fetch(`${ts.publicUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
      });
      expect(res.status).toBe(200);
    });

    it('rejects a refresh_token grant presented with a different client_id: invalid_grant', async () => {
      const registerA = await fetch(`${ts.publicUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      });
      const clientA = ((await registerA.json()) as { client_id: string }).client_id;
      const registerB = await fetch(`${ts.publicUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      });
      const clientB = ((await registerB.json()) as { client_id: string }).client_id;

      const code = await authorizeAndApprove(clientA, 'cross-client-refresh');
      const tokenRes = await fetch(`${ts.publicUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientA,
          code_verifier: verifier,
        }).toString(),
      });
      const { refresh_token: refreshToken } = (await tokenRes.json()) as { refresh_token: string };

      const refreshRes = await fetch(`${ts.publicUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientB,
        }).toString(),
      });
      expect(refreshRes.status).toBe(400);
      expect(((await refreshRes.json()) as { error: string }).error).toBe('invalid_grant');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('malformed and oversized requests never 500', () => {
    let ts: TestServer;
    let clientId: string;
    const redirectUri = 'http://127.0.0.1:9000/callback';

    beforeAll(async () => {
      ts = await startServer(accessKeys);
      const res = await fetch(`${ts.publicUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      });
      clientId = ((await res.json()) as { client_id: string }).client_id;
    });
    afterAll(() => stopServer(ts));

    it('a 10 KB state parameter at /oauth/authorize is rejected cleanly, not a 500', async () => {
      const hugeState = 'x'.repeat(10 * 1024);
      const url = new URL(`${ts.publicUrl}/oauth/authorize`);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('code_challenge', 'x'.repeat(43));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', hugeState);

      const jwt = await accessJwt();
      const res = await fetch(url, { headers: { 'cf-access-jwt-assertion': jwt } });
      expect(res.status).toBeLessThan(500);
    });

    it('a 10 KB client_id at /oauth/authorize is rejected as unknown, not a 500', async () => {
      const url = new URL(`${ts.publicUrl}/oauth/authorize`);
      url.searchParams.set('client_id', 'x'.repeat(10 * 1024));
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('code_challenge', 'x'.repeat(43));
      url.searchParams.set('code_challenge_method', 'S256');

      const res = await fetch(url);
      expect(res.status).toBe(400);
    });

    it('a 10 KB "code" at /oauth/token is rejected as invalid_grant, not a 500', async () => {
      const res = await fetch(`${ts.publicUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'x'.repeat(10 * 1024),
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: 'y'.repeat(64),
        }).toString(),
      });
      expect(res.status).toBeLessThan(500);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('HEAD /oauth/token never 500s (404 or 405)', async () => {
      const res = await fetch(`${ts.publicUrl}/oauth/token`, { method: 'HEAD' });
      expect([404, 405]).toContain(res.status);
    });

    it('GET /oauth/token never 500s (404 or 405)', async () => {
      const res = await fetch(`${ts.publicUrl}/oauth/token`, { method: 'GET' });
      expect([404, 405]).toContain(res.status);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('client registration capacity: HTTP 429 when full', () => {
    let ts: TestServer;
    beforeAll(async () => {
      ts = await startServer(accessKeys);
      // Fill the store directly (in-process, through the real store per the no-bypass rule) with
      // 200 clients that have each received a token, so none are evictable.
      for (let i = 0; i < 200; i++) {
        const client = ts.store.registerClient({ redirectUris: ['http://127.0.0.1:1/callback'] });
        ts.store.issueTokens(client.clientId, OWNER_EMAIL, 'claudia', null);
      }
    });
    afterAll(() => stopServer(ts));

    it('returns HTTP 429 with invalid_client_metadata once the client cap is full', async () => {
      const res = await fetch(`${ts.publicUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:1/callback'] }),
      });
      expect(res.status).toBe(429);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_client_metadata');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('/health never leaks config or secrets', () => {
    let server: Server;
    let publicUrl: string;
    const secretMarker = 'super-secret-signing-key-should-never-appear-in-a-response';

    beforeAll(async () => {
      const port = await reservePort();
      publicUrl = `http://127.0.0.1:${port}`;
      const app = createHttpApp({
        publicUrl,
        oauthRouter: express.Router(),
        bearer: (_req, res) => res.status(401).json({ error: 'invalid_token' }),
        health: () => {
          throw new Error(`db connection failed, key=${secretMarker}`);
        },
      });
      server = await new Promise<Server>((resolve) => {
        const s = app.listen(port, '127.0.0.1', () => resolve(s));
      });
    });
    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it('never includes secret material from a thrown error in the response body', async () => {
      const res = await fetch(`${publicUrl}/health`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain(secretMarker);
      expect(text).not.toContain('signing');
    });

    it('does not advertise the framework via X-Powered-By', async () => {
      const res = await fetch(`${publicUrl}/health`);
      expect(res.headers.get('x-powered-by')).toBeNull();
    });
  });
});
