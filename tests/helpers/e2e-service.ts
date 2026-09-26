// End-to-end harness (docs/KICKOFF.md "Testing bar: End to end"): starts the
// whole Claudia service in-process (src/main.ts startService) against a
// scratch vault and a temp CLAUDIA_HOME, with a fake clock and a fake ntfy
// server, and drives it over real HTTP with a real MCP client authorized
// through the real OAuth dance (mirrors tests/integration/mcp.test.ts).
//
// Deterministic by construction: FakeClock for all vault/scheduler time,
// temp dirs cleaned up on stop(), a local fake ntfy server (never the real
// one), and no network calls except to that local server. The vault file
// watcher runs for real (real fs.watch, real debounce timers) so tests that
// simulate the owner editing a file in Obsidian (tests/e2e scenario 4) see
// real pickup latency; `waitFor` below polls for that instead of sleeping a
// fixed amount.

import { createHash, randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { configFromObject, type ClaudiaConfig } from '../../src/config.ts';
import { startService, type RunningService } from '../../src/main.ts';
import type { TickReport } from '../../src/scheduler/scheduler.ts';
import { seedVault } from '../../src/ops/seed.ts';
import { createAccessKeyFixture, type AccessKeyFixture } from './access-keys.ts';
import { FakeClock } from './fake-clock.ts';
import { startFakeNtfy, type FakeNtfy } from './fake-ntfy.ts';

export const E2E_TEAM_DOMAIN = 'e2e-team.cloudflareaccess.com';
export const E2E_AUDIENCE = 'claudia-e2e-audience';
export const E2E_OWNER_EMAIL = 'aroop@example.com';
export const E2E_ISSUER = `https://${E2E_TEAM_DOMAIN}`;
export const E2E_NTFY_TOKEN = 'e2e-ntfy-token-do-not-use';
export const E2E_VAULT_NAME = 'ClaudiaE2E';

/** Sat 2026-09-26 10:00 America/Los_Angeles (matches tests/integration/mcp.test.ts's fixture instant). */
export const E2E_DEFAULT_NOW = '2026-09-26T17:00:00Z';

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function randomVerifier(): string {
  return randomBytes(48).toString('base64url');
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

/** Polls `check` (real wall-clock timers; unaffected by the FakeClock) until it returns truthy. */
export async function waitFor<T>(
  check: () => T | Promise<T | null | undefined | false> | null | undefined | false,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // `check` may throw while the awaited condition doesn't hold yet (e.g. a file that hasn't
    // been created by a debounced writer yet); treat that the same as a falsy result and retry.
    let result: T | null | undefined | false;
    try {
      result = await check();
    } catch {
      result = undefined;
    }
    if (result) return result;
    if (Date.now() >= deadline) {
      throw new Error(opts.message ?? `waitFor: condition not met within ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Performs the full OAuth dance (DCR, Access-JWT authorize/approve, PKCE token exchange) and connects an MCP client. */
async function authorizeMcpClient(opts: {
  publicUrl: string;
  accessKeys: AccessKeyFixture;
}): Promise<Client> {
  const { publicUrl, accessKeys } = opts;
  const redirectUri = 'http://127.0.0.1:0/callback';
  const verifier = randomVerifier();
  const challenge = pkceChallenge(verifier);

  const registerRes = await fetch(`${publicUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Claudia e2e test client' }),
  });
  if (registerRes.status !== 201) {
    throw new Error(`oauth/register failed: ${String(registerRes.status)}`);
  }
  const { client_id: clientId } = (await registerRes.json()) as { client_id: string };

  const authorizeUrl = new URL(`${publicUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('resource', `${publicUrl}/mcp`);
  authorizeUrl.searchParams.set('state', 'e2e-state');

  const jwt = await accessKeys.signAccessJwt({
    email: E2E_OWNER_EMAIL,
    aud: E2E_AUDIENCE,
    iss: E2E_ISSUER,
  });

  const authorizeRes = await fetch(authorizeUrl, { headers: { 'cf-access-jwt-assertion': jwt } });
  if (authorizeRes.status !== 200) {
    throw new Error(`oauth/authorize failed: ${String(authorizeRes.status)}`);
  }
  const html = await authorizeRes.text();
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
  if (approveRes.status !== 302) {
    throw new Error(`oauth/approve failed: ${String(approveRes.status)}`);
  }
  const location = new URL(approveRes.headers.get('location')!);
  const code = location.searchParams.get('code');
  if (!code) throw new Error('oauth/approve did not return a code');

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
  if (tokenRes.status !== 200) {
    throw new Error(`oauth/token failed: ${String(tokenRes.status)}`);
  }
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

  const transport = new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: 'claudia-e2e-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

export interface StartE2EOptions {
  /** ISO instant for the FakeClock; default Sat 2026-09-26 10:00 America/Los_Angeles. */
  now?: string;
  /** Runs the vault file watcher (real fs.watch); default true. */
  watch?: boolean;
}

export interface E2EService {
  /** The base URL the service is actually reachable at. Updated by restart(). */
  url: string;
  /** The connected, authorized MCP client. Updated by restart(); re-read this field, don't cache it. */
  mcp: Client;
  clock: FakeClock;
  vaultDir: string;
  home: string;
  ntfy: FakeNtfy;
  /** The live RunningService. Updated by restart(). */
  service: RunningService;
  config: ClaudiaConfig;
  accessKeys: AccessKeyFixture;
  readVault(rel: string): Promise<string>;
  writeVault(rel: string, text: string): Promise<void>;
  removeVault(rel: string): Promise<void>;
  vaultExists(rel: string): Promise<boolean>;
  /** Runs one scheduler tick immediately (no interval; schedulerAutoStart is always false here). */
  tick(): Promise<TickReport>;
  /**
   * Redoes the OAuth dance and replaces `mcp` with a freshly authorized client.
   * The server mints OAuth access-token expiry off the FakeClock (main.ts wires
   * `createOAuthStore` with `now: () => clock.now()`, matching production, where that clock is
   * real), so a client authorized before a multi-hour `clock.set`/`clock.advance` will see its
   * bearer token expire once the clock passes it. Cloudflare Access JWTs are independent of the
   * FakeClock (signed and verified against real wall-clock time), so this can be called any time.
   * Call it after advancing the clock by more than an hour and before the next MCP tool call.
   */
  reauthorize(): Promise<void>;
  /**
   * Stops the current service and starts a new one against the same vault and
   * CLAUDIA_HOME (state.db and, unless `deleteIndex`, index.db persist), then
   * redoes the OAuth dance for a fresh MCP client. Mutates `service`, `url`
   * and `mcp` in place.
   */
  restart(opts?: { deleteIndex?: boolean }): Promise<void>;
  stop(): Promise<void>;
}

function vaultFull(vaultDir: string, rel: string): string {
  return join(vaultDir, ...rel.split('/'));
}

/** Starts the whole Claudia service in-process against a fresh scratch vault, for one e2e test file. */
export async function startE2E(opts: StartE2EOptions = {}): Promise<E2EService> {
  const home = await mkdtemp(join(tmpdir(), 'claudia-e2e-home-'));
  const vaultDir = await mkdtemp(join(tmpdir(), 'claudia-e2e-vault-'));
  await seedVault(vaultDir);

  const accessKeys = await createAccessKeyFixture();
  const ntfy = await startFakeNtfy({ token: E2E_NTFY_TOKEN });
  const port = await reservePort();
  const publicUrl = `http://127.0.0.1:${String(port)}`;

  const rawConfig = {
    vaultPath: vaultDir,
    vaultName: E2E_VAULT_NAME,
    host: '127.0.0.1',
    port,
    publicUrl,
    ownerEmail: E2E_OWNER_EMAIL,
    access: { teamDomain: E2E_TEAM_DOMAIN, audience: E2E_AUDIENCE },
    ntfy: { baseUrl: ntfy.url, topic: 'claudia-e2e-topic' },
    quietMs: 0,
  };
  const config = configFromObject(home, rawConfig, {});

  await mkdir(dirname(config.paths.actionKeyFile), { recursive: true, mode: 0o700 });
  await writeFile(config.ntfy.tokenFile, E2E_NTFY_TOKEN, 'utf8');
  // Written for realism (a real install reads config.json from CLAUDIA_HOME); startService itself
  // takes the already-parsed ClaudiaConfig, so nothing reads this file back in these tests.
  await writeFile(join(home, 'config.json'), JSON.stringify(rawConfig, null, 2), 'utf8');

  const clock = new FakeClock(opts.now ?? E2E_DEFAULT_NOW);

  const service = await startService(config, {
    clock,
    accessJwks: accessKeys.jwks,
    watch: opts.watch !== false,
    schedulerAutoStart: false,
  });

  const mcp = await authorizeMcpClient({ publicUrl: service.url, accessKeys });

  const self: E2EService = {
    url: service.url,
    mcp,
    clock,
    vaultDir,
    home,
    ntfy,
    service,
    config,
    accessKeys,

    async readVault(rel: string): Promise<string> {
      return readFile(vaultFull(vaultDir, rel), 'utf8');
    },

    async writeVault(rel: string, text: string): Promise<void> {
      const full = vaultFull(vaultDir, rel);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text, 'utf8');
    },

    async removeVault(rel: string): Promise<void> {
      await rm(vaultFull(vaultDir, rel), { force: true });
    },

    async vaultExists(rel: string): Promise<boolean> {
      try {
        await readFile(vaultFull(vaultDir, rel), 'utf8');
        return true;
      } catch {
        return false;
      }
    },

    tick(): Promise<TickReport> {
      return self.service.scheduler.tick();
    },

    async reauthorize(): Promise<void> {
      try {
        await self.mcp.close();
      } catch {
        // already closed / never mattered
      }
      self.mcp = await authorizeMcpClient({ publicUrl: self.url, accessKeys });
    },

    async restart(restartOpts?: { deleteIndex?: boolean }): Promise<void> {
      try {
        await self.mcp.close();
      } catch {
        // already closed / never mattered
      }
      await self.service.stop();

      if (restartOpts?.deleteIndex) {
        await rm(config.paths.indexDb, { force: true });
        await rm(`${config.paths.indexDb}-wal`, { force: true });
        await rm(`${config.paths.indexDb}-shm`, { force: true });
      }

      const restarted = await startService(config, {
        clock: self.clock,
        accessJwks: accessKeys.jwks,
        watch: opts.watch !== false,
        schedulerAutoStart: false,
      });
      self.service = restarted;
      self.url = restarted.url;
      self.mcp = await authorizeMcpClient({ publicUrl: restarted.url, accessKeys });
    },

    async stop(): Promise<void> {
      try {
        await self.mcp.close();
      } catch {
        // already closed / never mattered
      }
      await self.service.stop();
      await ntfy.close();
      await rm(home, { recursive: true, force: true });
      await rm(vaultDir, { recursive: true, force: true });
    },
  };

  return self;
}
