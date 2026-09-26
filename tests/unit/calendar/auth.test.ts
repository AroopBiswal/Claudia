import { describe, expect, it } from 'vitest';
import { runCalendarAuth } from '../../../src/calendar/auth.ts';
import type { GoogleTokens, TokenStore } from '../../../src/calendar/google.ts';

const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const SECRETS = { client_id: 'client-123', client_secret: 'shh-secret' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createTokenStore(): TokenStore & { saves: GoogleTokens[] } {
  let current: GoogleTokens | null = null;
  const saves: GoogleTokens[] = [];
  return {
    load: () => Promise.resolve(current),
    save: (t: GoogleTokens) => {
      current = t;
      saves.push(t);
      return Promise.resolve();
    },
    saves,
  };
}

/** Hits our own loopback callback server with a real local HTTP GET (never Google). */
async function hitCallback(
  callbackParams: Record<string, string>,
  redirectUri: string,
): Promise<Response> {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(callbackParams)) {
    url.searchParams.set(key, value);
  }
  return fetch(url.toString());
}

describe('runCalendarAuth', () => {
  it('completes the success path: builds the auth URL, exchanges the code, and saves tokens', async () => {
    const tokenStore = createTokenStore();
    const logs: string[] = [];
    let authUrl = '';

    const tokenFetch = ((url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      expect(init?.method).toBe('POST');
      const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('test-auth-code');
      expect(body.get('client_id')).toBe(SECRETS.client_id);
      expect(body.get('client_secret')).toBe(SECRETS.client_secret);
      expect(body.get('code_verifier')).toBeTruthy();
      expect(body.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      return Promise.resolve(
        jsonResponse(200, {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: SCOPE,
          token_type: 'Bearer',
        }),
      );
    }) as typeof fetch;

    const openUrl = async (url: string): Promise<void> => {
      authUrl = url;
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';
      const state = parsed.searchParams.get('state') ?? '';
      const res = await hitCallback({ code: 'test-auth-code', state }, redirectUri);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('close this tab');
    };

    await runCalendarAuth({
      secrets: SECRETS,
      tokens: tokenStore,
      openUrl,
      log: (line) => logs.push(line),
      fetch: tokenFetch,
      timeoutMs: 5000,
      port: 0,
    });

    expect(tokenStore.saves).toHaveLength(1);
    expect(tokenStore.saves[0]).toMatchObject({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      scope: SCOPE,
    });
    expect(typeof tokenStore.saves[0]?.expiry).toBe('number');

    expect(authUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    const parsedAuthUrl = new URL(authUrl);
    expect(parsedAuthUrl.searchParams.get('client_id')).toBe(SECRETS.client_id);
    expect(parsedAuthUrl.searchParams.get('response_type')).toBe('code');
    expect(parsedAuthUrl.searchParams.get('access_type')).toBe('offline');
    expect(parsedAuthUrl.searchParams.get('prompt')).toBe('consent');
    expect(parsedAuthUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsedAuthUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(logs.some((line) => line.includes('accounts.google.com'))).toBe(true);
  });

  it('uses exactly the calendar.app.created scope, nothing broader', async () => {
    const tokenStore = createTokenStore();
    let authUrl = '';

    const openUrl = async (url: string): Promise<void> => {
      authUrl = url;
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';
      const state = parsed.searchParams.get('state') ?? '';
      await hitCallback({ code: 'code-x', state }, redirectUri);
    };

    const tokenFetch = (() =>
      Promise.resolve(
        jsonResponse(200, {
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
          scope: SCOPE,
        }),
      )) as typeof fetch;

    await runCalendarAuth({
      secrets: SECRETS,
      tokens: tokenStore,
      openUrl,
      log: () => {},
      fetch: tokenFetch,
      timeoutMs: 5000,
    });

    const scope = new URL(authUrl).searchParams.get('scope');
    expect(scope).toBe(SCOPE);
  });

  it('rejects on a state mismatch and never calls the token endpoint', async () => {
    const tokenStore = createTokenStore();
    let tokenFetchCalled = false;
    const tokenFetch = (() => {
      tokenFetchCalled = true;
      return Promise.resolve(jsonResponse(200, {}));
    }) as typeof fetch;

    const openUrl = async (url: string): Promise<void> => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';
      await hitCallback({ code: 'some-code', state: 'wrong-state' }, redirectUri);
    };

    await expect(
      runCalendarAuth({
        secrets: SECRETS,
        tokens: tokenStore,
        openUrl,
        log: () => {},
        fetch: tokenFetch,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/state/i);

    expect(tokenFetchCalled).toBe(false);
    expect(tokenStore.saves).toHaveLength(0);
  });

  it('rejects when Google reports access_denied', async () => {
    const tokenStore = createTokenStore();

    const openUrl = async (url: string): Promise<void> => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';
      const state = parsed.searchParams.get('state') ?? '';
      await hitCallback({ error: 'access_denied', state }, redirectUri);
    };

    await expect(
      runCalendarAuth({
        secrets: SECRETS,
        tokens: tokenStore,
        openUrl,
        log: () => {},
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/access_denied/);

    expect(tokenStore.saves).toHaveLength(0);
  });

  it('rejects with a clear error when Google does not return a refresh token', async () => {
    const tokenStore = createTokenStore();
    const tokenFetch = (() =>
      Promise.resolve(jsonResponse(200, { access_token: 'a', expires_in: 3600 }))) as typeof fetch;

    const openUrl = async (url: string): Promise<void> => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';
      const state = parsed.searchParams.get('state') ?? '';
      await hitCallback({ code: 'code-y', state }, redirectUri);
    };

    await expect(
      runCalendarAuth({
        secrets: SECRETS,
        tokens: tokenStore,
        openUrl,
        log: () => {},
        fetch: tokenFetch,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/refresh token/i);

    expect(tokenStore.saves).toHaveLength(0);
  });

  it('times out when no callback ever arrives', async () => {
    const tokenStore = createTokenStore();

    await expect(
      runCalendarAuth({
        secrets: SECRETS,
        tokens: tokenStore,
        openUrl: () => {},
        log: () => {},
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/i);
  });
});
