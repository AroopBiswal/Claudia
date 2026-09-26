import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClientCapacityError, createOAuthStore, type OAuthStore } from '../../../src/auth/store.ts';

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('createOAuthStore', () => {
  let db: DatabaseSync;
  let clock: number;
  let store: OAuthStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    clock = Date.parse('2026-01-01T00:00:00.000Z');
    store = createOAuthStore(db, { now: () => new Date(clock) });
    store.migrate();
  });

  function advance(ms: number): void {
    clock += ms;
  }

  function registerBasicClient() {
    return store.registerClient({ redirectUris: ['http://127.0.0.1:1234/callback'] });
  }

  describe('registerClient', () => {
    it('never stores the plaintext client secret, only its hash', () => {
      const registered = store.registerClient({
        redirectUris: ['http://127.0.0.1:1234/callback'],
        tokenEndpointAuthMethod: 'client_secret_post',
      });
      expect(registered.clientSecret).toBeDefined();

      const rows = db
        .prepare('SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?')
        .all(registered.clientId) as { client_secret_hash: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.client_secret_hash).toBe(sha256hex(registered.clientSecret!));
      expect(rows[0]?.client_secret_hash).not.toBe(registered.clientSecret);
    });

    it('does not issue a secret for the none auth method', () => {
      const registered = registerBasicClient();
      expect(registered.clientSecret).toBeUndefined();
    });

    it('rejects grant types beyond the supported set at the router layer, but stores whatever is asked at the store layer', () => {
      // The store itself is a dumb persistence layer; grant type validation is the router's job.
      const registered = store.registerClient({
        redirectUris: ['http://127.0.0.1:1/callback'],
        grantTypes: ['authorization_code'],
      });
      expect(registered.grantTypes).toEqual(['authorization_code']);
    });

    it('caps the number of clients at 200 by evicting the oldest client that never received a token', () => {
      const ids: string[] = [];
      for (let i = 0; i < 200; i++) {
        advance(1);
        ids.push(registerBasicClient().clientId);
      }
      const oldestId = ids[0]!;
      expect(store.getClient(oldestId)).toBeDefined();

      advance(1);
      const newClient = registerBasicClient();

      expect(store.getClient(oldestId)).toBeUndefined();
      expect(store.getClient(newClient.clientId)).toBeDefined();

      const countRow = db.prepare('SELECT COUNT(*) as n FROM oauth_clients').get() as { n: number };
      expect(countRow.n).toBe(200);
    });

    it('rejects registration when full and every client has already received a token', () => {
      for (let i = 0; i < 200; i++) {
        advance(1);
        const client = registerBasicClient();
        store.issueTokens(client.clientId, 'owner@example.com', 'claudia', null);
      }

      expect(() => registerBasicClient()).toThrow(ClientCapacityError);
    });
  });

  describe('authorization codes', () => {
    it('are single use: consuming twice returns null the second time', () => {
      const { code } = store.createCode({
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:1/callback',
        codeChallenge: 'challenge',
        scope: 'claudia',
        resource: null,
        subject: 'owner@example.com',
      });

      const first = store.consumeCode(code);
      expect(first).toMatchObject({ clientId: 'client-1', subject: 'owner@example.com' });

      const second = store.consumeCode(code);
      expect(second).toBeNull();
    });

    it('are rejected once expired (5 minute TTL)', () => {
      const { code } = store.createCode({
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:1/callback',
        codeChallenge: 'challenge',
        scope: 'claudia',
        resource: null,
        subject: 'owner@example.com',
      });

      advance(5 * 60 * 1000 + 1);
      expect(store.consumeCode(code)).toBeNull();
    });

    it('are valid right up to the TTL boundary', () => {
      const { code } = store.createCode({
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:1/callback',
        codeChallenge: 'challenge',
        scope: 'claudia',
        resource: null,
        subject: 'owner@example.com',
      });

      advance(5 * 60 * 1000);
      expect(store.consumeCode(code)).not.toBeNull();
    });

    it('only stores a hash of the code, never the plaintext', () => {
      const { code } = store.createCode({
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:1/callback',
        codeChallenge: 'challenge',
        scope: 'claudia',
        resource: null,
        subject: 'owner@example.com',
      });

      const rows = db.prepare('SELECT code_hash FROM oauth_codes').all() as { code_hash: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.code_hash).toBe(sha256hex(code));
    });

    it('returns null for an unknown code', () => {
      expect(store.consumeCode('never-issued')).toBeNull();
    });
  });

  describe('tokens', () => {
    it('only stores hashes of access and refresh tokens', () => {
      const tokens = store.issueTokens('client-1', 'owner@example.com', 'claudia', null);
      const rows = db.prepare('SELECT token_hash FROM oauth_tokens').all() as {
        token_hash: string;
      }[];
      const hashes = rows.map((r) => r.token_hash);
      expect(hashes).toContain(sha256hex(tokens.accessToken));
      expect(hashes).toContain(sha256hex(tokens.refreshToken));
      expect(hashes).not.toContain(tokens.accessToken);
      expect(hashes).not.toContain(tokens.refreshToken);
    });

    it('marks the client as having received a token', () => {
      const client = registerBasicClient();
      expect(store.getClient(client.clientId)?.everIssuedToken).toBe(false);
      store.issueTokens(client.clientId, 'owner@example.com', 'claudia', null);
      expect(store.getClient(client.clientId)?.everIssuedToken).toBe(true);
    });

    it('verifies a freshly issued access token', () => {
      const tokens = store.issueTokens(
        'client-1',
        'owner@example.com',
        'claudia',
        'https://claudia.example.com/mcp',
      );
      const info = store.verifyAccessToken(tokens.accessToken);
      expect(info).toMatchObject({
        clientId: 'client-1',
        subject: 'owner@example.com',
        scope: 'claudia',
        resource: 'https://claudia.example.com/mcp',
      });
    });

    it('expires access tokens after 1 hour', () => {
      const tokens = store.issueTokens('client-1', 'owner@example.com', 'claudia', null);
      advance(60 * 60 * 1000 + 1);
      expect(store.verifyAccessToken(tokens.accessToken)).toBeNull();
    });

    it('keeps access tokens valid right up to the 1 hour boundary', () => {
      const tokens = store.issueTokens('client-1', 'owner@example.com', 'claudia', null);
      advance(60 * 60 * 1000);
      expect(store.verifyAccessToken(tokens.accessToken)).not.toBeNull();
    });

    it('rejects an unknown access token', () => {
      expect(store.verifyAccessToken('not-a-real-token')).toBeNull();
    });

    it('rejects a refresh token presented as an access token', () => {
      const tokens = store.issueTokens('client-1', 'owner@example.com', 'claudia', null);
      expect(store.verifyAccessToken(tokens.refreshToken)).toBeNull();
    });

    describe('refresh rotation', () => {
      it('issues a new pair and invalidates the old refresh token', () => {
        const first = store.issueTokens('client-1', 'owner@example.com', 'claudia', null);

        const rotated = store.refreshTokens(first.refreshToken, 'client-1');
        expect(rotated.ok).toBe(true);
        if (!rotated.ok) throw new Error('unreachable');
        expect(rotated.tokens.accessToken).not.toBe(first.accessToken);
        expect(rotated.tokens.refreshToken).not.toBe(first.refreshToken);

        // The old refresh token is now single-use spent.
        const reuseAttempt = store.refreshTokens(first.refreshToken, 'client-1');
        expect(reuseAttempt.ok).toBe(false);
      });

      it('the new access token from a rotation is valid', () => {
        const first = store.issueTokens('client-1', 'owner@example.com', 'claudia', null);
        const rotated = store.refreshTokens(first.refreshToken, 'client-1');
        if (!rotated.ok) throw new Error('unreachable');
        expect(store.verifyAccessToken(rotated.tokens.accessToken)).not.toBeNull();
      });

      it('reusing an already-rotated refresh token revokes the whole family, including the latest access token', () => {
        const first = store.issueTokens('client-1', 'owner@example.com', 'claudia', null);
        const rotated = store.refreshTokens(first.refreshToken, 'client-1');
        if (!rotated.ok) throw new Error('unreachable');

        expect(store.verifyAccessToken(rotated.tokens.accessToken)).not.toBeNull();

        // Reuse the original (already-spent) refresh token: this is the theft signal.
        const reuse = store.refreshTokens(first.refreshToken, 'client-1');
        expect(reuse.ok).toBe(false);

        // The entire family, including the access token minted by the legitimate rotation, is now dead.
        expect(store.verifyAccessToken(rotated.tokens.accessToken)).toBeNull();
        const rotatedAgain = store.refreshTokens(rotated.tokens.refreshToken, 'client-1');
        expect(rotatedAgain.ok).toBe(false);
      });

      it('rejects refresh tokens for the wrong client', () => {
        const first = store.issueTokens('client-1', 'owner@example.com', 'claudia', null);
        const result = store.refreshTokens(first.refreshToken, 'client-2');
        expect(result.ok).toBe(false);
      });

      it('rejects an unknown refresh token', () => {
        expect(store.refreshTokens('never-issued', 'client-1').ok).toBe(false);
      });

      it('expires refresh tokens after 30 days', () => {
        const first = store.issueTokens('client-1', 'owner@example.com', 'claudia', null);
        advance(30 * 24 * 60 * 60 * 1000 + 1);
        expect(store.refreshTokens(first.refreshToken, 'client-1').ok).toBe(false);
      });

      it('rejects a resource that does not match the original grant', () => {
        const first = store.issueTokens(
          'client-1',
          'owner@example.com',
          'claudia',
          'https://claudia.example.com/mcp',
        );
        const result = store.refreshTokens(
          first.refreshToken,
          'client-1',
          'https://other.example.com/mcp',
        );
        expect(result.ok).toBe(false);
      });
    });

    describe('revocation', () => {
      it('revoking an access token only revokes that token', () => {
        const tokens = store.issueTokens('client-1', 'owner@example.com', 'claudia', null);
        store.revokeToken(tokens.accessToken);
        expect(store.verifyAccessToken(tokens.accessToken)).toBeNull();
        expect(store.refreshTokens(tokens.refreshToken, 'client-1').ok).toBe(true);
      });

      it('revoking a refresh token revokes the whole family', () => {
        const tokens = store.issueTokens('client-1', 'owner@example.com', 'claudia', null);
        store.revokeToken(tokens.refreshToken);
        expect(store.verifyAccessToken(tokens.accessToken)).toBeNull();
        expect(store.refreshTokens(tokens.refreshToken, 'client-1').ok).toBe(false);
      });

      it('revoking an unknown token is a silent no-op', () => {
        expect(() => store.revokeToken('never-issued')).not.toThrow();
      });
    });
  });

  describe('client secret verification', () => {
    it('accepts the correct secret', () => {
      const registered = store.registerClient({
        redirectUris: ['http://127.0.0.1:1/callback'],
        tokenEndpointAuthMethod: 'client_secret_post',
      });
      const client = store.getClient(registered.clientId)!;
      expect(store.verifyClientSecret(client, registered.clientSecret!)).toBe(true);
    });

    it('rejects an incorrect secret', () => {
      const registered = store.registerClient({
        redirectUris: ['http://127.0.0.1:1/callback'],
        tokenEndpointAuthMethod: 'client_secret_post',
      });
      const client = store.getClient(registered.clientId)!;
      expect(store.verifyClientSecret(client, 'wrong-secret')).toBe(false);
    });

    it('rejects any secret for a public (none) client', () => {
      const registered = registerBasicClient();
      const client = store.getClient(registered.clientId)!;
      expect(store.verifyClientSecret(client, 'anything')).toBe(false);
    });
  });
});
