import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_CLIENTS = 200;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type TokenEndpointAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

/** Thrown by registerClient when the store is full of clients that have already received a token. */
export class ClientCapacityError extends Error {
  constructor() {
    super('Too many registered OAuth clients.');
    this.name = 'ClientCapacityError';
  }
}

export interface ClientRegistrationInput {
  redirectUris: string[];
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  grantTypes?: string[];
  responseTypes?: string[];
  clientName?: string;
  scope?: string;
}

export interface RegisteredClient {
  clientId: string;
  /** Present only for confidential clients; the plaintext secret is never stored. */
  clientSecret?: string;
  clientIdIssuedAt: number;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  clientName?: string;
  scope: string;
}

export interface ClientRecord {
  clientId: string;
  clientSecretHash: string | null;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  clientName?: string;
  scope: string;
  createdAt: number;
  everIssuedToken: boolean;
}

export interface CreateCodeInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
  subject: string;
}

export interface IssuedCode {
  code: string;
  expiresAt: number;
}

export interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
  subject: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string;
}

export interface AccessTokenInfo {
  clientId: string;
  subject: string;
  scope: string;
  resource: string | null;
  expiresAt: number;
}

export type RefreshResult =
  { ok: true; tokens: TokenPair } | { ok: false; reason: 'invalid_grant' };

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  token_endpoint_auth_method: TokenEndpointAuthMethod;
  redirect_uris: string;
  grant_types: string;
  response_types: string;
  client_name: string | null;
  scope: string;
  created_at: number;
  ever_issued_token: number;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string | null;
  subject: string;
  created_at: number;
  expires_at: number;
}

interface TokenRow {
  token_hash: string;
  type: 'access' | 'refresh';
  client_id: string;
  subject: string;
  scope: string;
  resource: string | null;
  family_id: string;
  created_at: number;
  expires_at: number;
  replaced_by: string | null;
  revoked: number;
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createOAuthStore(db: DatabaseSync, opts: { now: () => Date }) {
  const nowMs = () => opts.now().getTime();

  function migrate(): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret_hash TEXT,
        token_endpoint_auth_method TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        grant_types TEXT NOT NULL,
        response_types TEXT NOT NULL,
        client_name TEXT,
        scope TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ever_issued_token INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT,
        subject TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT,
        family_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        replaced_by TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family_id);
      CREATE TABLE IF NOT EXISTS oauth_used_approvals (
        request_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  function rowToClient(row: ClientRow): ClientRecord {
    return {
      clientId: row.client_id,
      clientSecretHash: row.client_secret_hash,
      tokenEndpointAuthMethod: row.token_endpoint_auth_method,
      redirectUris: JSON.parse(row.redirect_uris) as string[],
      grantTypes: JSON.parse(row.grant_types) as string[],
      responseTypes: JSON.parse(row.response_types) as string[],
      clientName: row.client_name ?? undefined,
      scope: row.scope,
      createdAt: row.created_at,
      everIssuedToken: row.ever_issued_token === 1,
    };
  }

  function registerClient(input: ClientRegistrationInput): RegisteredClient {
    const countRow = db.prepare('SELECT COUNT(*) as n FROM oauth_clients').get() as { n: number };
    if (countRow.n >= MAX_CLIENTS) {
      const evictable = db
        .prepare(
          'SELECT client_id FROM oauth_clients WHERE ever_issued_token = 0 ORDER BY created_at ASC LIMIT 1',
        )
        .get() as { client_id: string } | undefined;
      if (evictable) {
        db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(evictable.client_id);
      } else {
        throw new ClientCapacityError();
      }
    }

    const clientId = randomToken(16);
    const tokenEndpointAuthMethod = input.tokenEndpointAuthMethod ?? 'none';
    const needsSecret = tokenEndpointAuthMethod !== 'none';
    const clientSecret = needsSecret ? randomToken(32) : undefined;
    const clientSecretHash = clientSecret ? sha256hex(clientSecret) : null;
    const createdAt = nowMs();
    const grantTypes = input.grantTypes ?? ['authorization_code', 'refresh_token'];
    const responseTypes = input.responseTypes ?? ['code'];
    const scope = input.scope ?? 'claudia';

    db.prepare(
      `INSERT INTO oauth_clients
        (client_id, client_secret_hash, token_endpoint_auth_method, redirect_uris, grant_types, response_types, client_name, scope, created_at, ever_issued_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      clientId,
      clientSecretHash,
      tokenEndpointAuthMethod,
      JSON.stringify(input.redirectUris),
      JSON.stringify(grantTypes),
      JSON.stringify(responseTypes),
      input.clientName ?? null,
      scope,
      createdAt,
    );

    return {
      clientId,
      clientSecret,
      clientIdIssuedAt: Math.floor(createdAt / 1000),
      tokenEndpointAuthMethod,
      redirectUris: input.redirectUris,
      grantTypes,
      responseTypes,
      clientName: input.clientName,
      scope,
    };
  }

  function getClient(clientId: string): ClientRecord | undefined {
    const row = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as
      ClientRow | undefined;
    return row ? rowToClient(row) : undefined;
  }

  function verifyClientSecret(client: ClientRecord, secret: string): boolean {
    if (!client.clientSecretHash) return false;
    return hashesEqual(sha256hex(secret), client.clientSecretHash);
  }

  function createCode(input: CreateCodeInput): IssuedCode {
    const code = randomToken(32);
    const codeHash = sha256hex(code);
    const createdAt = nowMs();
    const expiresAt = createdAt + CODE_TTL_MS;

    db.prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, subject, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      codeHash,
      input.clientId,
      input.redirectUri,
      input.codeChallenge,
      input.scope,
      input.resource,
      input.subject,
      createdAt,
      expiresAt,
    );

    return { code, expiresAt };
  }

  /** Single-use: the code row is deleted as soon as it is looked up, valid or not. */
  function consumeCode(code: string): CodeRecord | null {
    const hash = sha256hex(code);
    const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash) as
      CodeRow | undefined;
    if (!row) return null;

    db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(hash);

    if (row.expires_at < nowMs()) return null;

    return {
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      scope: row.scope,
      resource: row.resource,
      subject: row.subject,
    };
  }

  function insertTokenPair(
    clientId: string,
    subject: string,
    scope: string,
    resource: string | null,
    familyId: string,
  ): TokenPair {
    const createdAt = nowMs();
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const accessExpiresAt = createdAt + ACCESS_TOKEN_TTL_MS;
    const refreshExpiresAt = createdAt + REFRESH_TOKEN_TTL_MS;

    db.prepare(
      `INSERT INTO oauth_tokens (token_hash, type, client_id, subject, scope, resource, family_id, created_at, expires_at, replaced_by, revoked)
       VALUES (?, 'access', ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
    ).run(
      sha256hex(accessToken),
      clientId,
      subject,
      scope,
      resource,
      familyId,
      createdAt,
      accessExpiresAt,
    );

    db.prepare(
      `INSERT INTO oauth_tokens (token_hash, type, client_id, subject, scope, resource, family_id, created_at, expires_at, replaced_by, revoked)
       VALUES (?, 'refresh', ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
    ).run(
      sha256hex(refreshToken),
      clientId,
      subject,
      scope,
      resource,
      familyId,
      createdAt,
      refreshExpiresAt,
    );

    db.prepare('UPDATE oauth_clients SET ever_issued_token = 1 WHERE client_id = ?').run(clientId);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope,
    };
  }

  function issueTokens(
    clientId: string,
    subject: string,
    scope: string,
    resource: string | null,
  ): TokenPair {
    const familyId = randomToken(16);
    return insertTokenPair(clientId, subject, scope, resource, familyId);
  }

  /**
   * Rotates a refresh token. A refresh token can only ever be redeemed once: redeeming it a
   * second time is treated as token theft (reuse detection) and revokes every token issued in
   * its family, including the pair that the first redemption produced.
   */
  function refreshTokens(
    refreshToken: string,
    clientId: string,
    resource?: string | null,
  ): RefreshResult {
    const hash = sha256hex(refreshToken);
    const row = db
      .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND type = 'refresh'")
      .get(hash) as TokenRow | undefined;
    if (!row) return { ok: false, reason: 'invalid_grant' };

    if (row.client_id !== clientId) return { ok: false, reason: 'invalid_grant' };

    if (row.revoked === 1) {
      // Reuse of an already-redeemed (or otherwise revoked) refresh token: burn the family.
      db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE family_id = ?').run(row.family_id);
      return { ok: false, reason: 'invalid_grant' };
    }

    if (row.expires_at < nowMs()) return { ok: false, reason: 'invalid_grant' };

    if (resource && row.resource && resource !== row.resource) {
      return { ok: false, reason: 'invalid_grant' };
    }

    const tokens = insertTokenPair(
      row.client_id,
      row.subject,
      row.scope,
      row.resource,
      row.family_id,
    );
    db.prepare('UPDATE oauth_tokens SET replaced_by = ?, revoked = 1 WHERE token_hash = ?').run(
      sha256hex(tokens.refreshToken),
      hash,
    );

    return { ok: true, tokens };
  }

  function verifyAccessToken(token: string): AccessTokenInfo | null {
    const hash = sha256hex(token);
    const row = db
      .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND type = 'access'")
      .get(hash) as TokenRow | undefined;
    if (!row) return null;
    if (row.revoked === 1) return null;
    if (row.expires_at < nowMs()) return null;

    return {
      clientId: row.client_id,
      subject: row.subject,
      scope: row.scope,
      resource: row.resource,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Marks a signed OAuth approval request (the token carried across the /oauth/authorize ->
   * /oauth/approve hop) as used, keyed by a hash of the request token. Returns true the first
   * time a given request is consumed, false on every subsequent attempt (replay), so a code can
   * never be minted twice from the same approval. `expiresAt` (epoch ms) is stored so that stale
   * rows can be pruned; it does not extend how long the hash itself is remembered as used.
   */
  function consumeApprovalOnce(requestHash: string, expiresAt: number): boolean {
    db.prepare('DELETE FROM oauth_used_approvals WHERE expires_at < ?').run(nowMs());
    try {
      db.prepare('INSERT INTO oauth_used_approvals (request_hash, expires_at) VALUES (?, ?)').run(
        requestHash,
        expiresAt,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** RFC 7009: revoking a refresh token revokes its whole family; revoking an access token revokes only itself. */
  function revokeToken(token: string): void {
    const hash = sha256hex(token);
    const row = db
      .prepare('SELECT type, family_id FROM oauth_tokens WHERE token_hash = ?')
      .get(hash) as Pick<TokenRow, 'type' | 'family_id'> | undefined;
    if (!row) return;

    if (row.type === 'refresh') {
      db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE family_id = ?').run(row.family_id);
    } else {
      db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?').run(hash);
    }
  }

  return {
    migrate,
    registerClient,
    getClient,
    verifyClientSecret,
    createCode,
    consumeCode,
    issueTokens,
    refreshTokens,
    verifyAccessToken,
    revokeToken,
    consumeApprovalOnce,
  };
}

export type OAuthStore = ReturnType<typeof createOAuthStore>;
