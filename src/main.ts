// Wires the Claudia service together for `claudia serve` (src/cli.ts): the
// vault index/state/writer, the OAuth authorization server, the MCP HTTP
// layer, the file watcher and the generated-notes refresher. Everything
// time-, network- and filesystem-dependent that a test needs to fake is
// accepted through `ServiceOptions`, never through config or env vars
// (docs/DECISIONS.md B10: no bypass).

import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { JWTVerifyGetKey } from 'jose';
import type { Router } from 'express';

import { createAccessVerifier } from './auth/access.ts';
import { createOAuthRouter, requireBearer } from './auth/oauth.ts';
import { createOAuthStore } from './auth/store.ts';
import {
  createGoogleCalendarClient,
  fileTokenStore,
  readClientSecrets,
  type CalendarClient,
  type IdStore,
} from './calendar/google.ts';
import { createCalendarSync } from './calendar/sync.ts';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { ClaudiaConfig } from './config.ts';
import { assignMissingIds } from './engine/idassign.ts';
import { openIndex, type Index } from './engine/index.ts';
import { runJanitor } from './engine/janitor.ts';
import { openState, type State } from './engine/state.ts';
import { createVaultWriter, type VaultWriter } from './engine/writer.ts';
import { createWatcher, type Watcher } from './engine/watcher.ts';
import { createHealth, type HealthDeps } from './health.ts';
import { createMcpHandler } from './http/mcp.ts';
import { createActionsRouter } from './http/actions.ts';
import { createHttpApp } from './http/app.ts';
import { createScheduler, type Scheduler } from './scheduler/scheduler.ts';
import type { Notifier } from './notify/ntfy.ts';
import { createNtfyNotifier } from './notify/ntfy.ts';
import { loadOrCreateSecret, readSecretText } from './secrets.ts';
import { appendLog } from './services/log.ts';
import { createGeneratedRefresher } from './services/generated.ts';
import type { ClaudiaContext } from './services/context.ts';
import { conflictCopyBase } from './vault/layout.ts';

export interface ServiceOptions {
  /** Overrides the system clock. Tests only. */
  clock?: Clock;
  /** Overrides the remote Cloudflare Access JWKS lookup with a local one. Tests only. */
  accessJwks?: JWTVerifyGetKey;
  /** Overrides ntfy auto-detection; pass `null` to force "not configured". Tests only. */
  notifier?: Notifier | null;
  /** Overrides Google Calendar auto-detection; pass `null` to force "not configured". Tests only. */
  calendarClient?: CalendarClient | null;
  /** Overrides the global fetch used by the calendar client and ntfy notifier. Tests only. */
  fetch?: typeof fetch;
  /** Additional Express routers mounted on the HTTP app (e.g. the scheduler's /a/<token> routes). */
  extraRouters?: Router[];
  /** Starts a background job runner (e.g. the scheduler); its `stop()` is called by `stop()`. */
  startBackground?: (ctx: ClaudiaContext) => { stop(): void };
  /** Start the scheduler's 30-second loop (default true). Tests turn it off and call `scheduler.tick()`. */
  schedulerAutoStart?: boolean;
  /** Disables the vault file watcher. Default true. Tests set this to `false`. */
  watch?: boolean;
  /** Starts the HTTP server. Default true. */
  listen?: boolean;
  /** Listens on port 0 (OS-assigned) instead of `config.port`. Tests only. */
  port0?: boolean;
}

export interface RunningService {
  ctx: ClaudiaContext;
  /** The base URL the HTTP server is actually reachable at, or `config.publicUrl` when not listening. */
  url: string;
  scheduler: Scheduler;
  stop(): Promise<void>;
}

const INDEX_REBUILD_RETRY_MS = 60_000;
const INITIAL_REBUILD_WAIT_MS = 5_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fileIdStore(path: string): IdStore {
  return {
    load(): Promise<string | null> {
      return Promise.resolve(readSecretText(path));
    },
    async save(id: string): Promise<void> {
      await writeFile(path, id, 'utf8');
    },
  };
}

function detectCalendarClient(
  config: ClaudiaConfig,
  fetchImpl: typeof fetch,
  now: () => Date,
  timeZone: string,
): CalendarClient | null {
  if (!existsSync(config.calendar.clientSecretsFile)) return null;
  if (!existsSync(config.calendar.tokenFile)) return null;
  const secrets = readClientSecrets(config.calendar.clientSecretsFile);
  return createGoogleCalendarClient({
    secrets,
    tokens: fileTokenStore(config.calendar.tokenFile),
    idStore: fileIdStore(config.calendar.idFile),
    timeZone,
    fetch: fetchImpl,
    now,
  });
}

function detectNotifier(config: ClaudiaConfig, fetchImpl: typeof fetch): Notifier | null {
  if (!config.ntfy.topic) return null;
  const token = readSecretText(config.ntfy.tokenFile);
  if (token === null) return null;
  return createNtfyNotifier({
    baseUrl: config.ntfy.baseUrl,
    topic: config.ntfy.topic,
    token,
    fetch: fetchImpl,
  });
}

/** Ensures a Claudia-owned directory exists, private (0700) since it may hold secrets or state. */
function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export async function startService(
  config: ClaudiaConfig,
  opts: ServiceOptions = {},
): Promise<RunningService> {
  const clock = opts.clock ?? systemClock;
  const fetchImpl = opts.fetch ?? fetch;

  function log(message: string): void {
    console.error(`[${new Date().toISOString()}] ${message}`);
  }

  ensureDir(config.home);
  ensureDir(config.paths.secretsDir);
  ensureDir(config.paths.logsDir);
  ensureDir(config.paths.backupsDir);

  const state: State = openState({ dbPath: config.paths.stateDb, now: () => clock.now() });
  const oauthStore = createOAuthStore(state.db, { now: () => clock.now() });
  oauthStore.migrate();

  const index: Index = openIndex({
    dbPath: config.paths.indexDb,
    vaultDir: config.vaultPath,
    now: () => clock.now(),
  });

  // The first rebuild is the first time the service touches the vault. Under launchd, macOS may
  // hold that call until the owner grants access (docs/HUMAN_TODO.md 1), so it runs in the
  // background with at most one attempt in flight, and the HTTP server starts regardless.
  let stopped = false;
  let rebuildRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let rebuilding: Promise<void> | null = null;
  let vaultReady = false;
  let onVaultReady: () => void = () => {};
  function startRebuild(): Promise<void> {
    if (rebuilding) return rebuilding;
    rebuilding = (async () => {
      try {
        const result = await index.rebuild();
        log(`index rebuilt: ${String(result.notes)} notes, ${String(result.items)} items`);
        if (result.skipped.length > 0) {
          log(
            `could not read ${String(result.skipped.length)} note(s), will retry: ${result.skipped.join(', ')}`,
          );
        }
        if (!vaultReady) {
          vaultReady = true;
          onVaultReady();
        }
      } catch (err) {
        log(`index rebuild failed, will retry in 60s: ${errorMessage(err)}`);
        rebuildRetryTimer = setTimeout(() => {
          void startRebuild();
        }, INDEX_REBUILD_RETRY_MS);
        rebuildRetryTimer.unref?.();
      } finally {
        rebuilding = null;
      }
    })();
    return rebuilding;
  }
  const initialRebuild = startRebuild();
  await Promise.race([
    initialRebuild,
    new Promise<void>((resolve) => setTimeout(resolve, INITIAL_REBUILD_WAIT_MS).unref()),
  ]);
  if (!vaultReady) log('vault not readable yet; serving /health as degraded until it is');

  const writer: VaultWriter = createVaultWriter({
    vaultDir: config.vaultPath,
    now: () => clock.now(),
    quietMs: config.quietMs,
  });

  const actionKey = loadOrCreateSecret(config.paths.actionKeyFile);
  const oauthKey = loadOrCreateSecret(config.paths.oauthKeyFile);

  const notifier = opts.notifier !== undefined ? opts.notifier : detectNotifier(config, fetchImpl);
  const calendarClient =
    opts.calendarClient !== undefined
      ? opts.calendarClient
      : detectCalendarClient(
          config,
          fetchImpl,
          () => clock.now(),
          index.settings().settings.timeZone,
        );

  // Only wire up the calendar sync when a real Google client is available: capture's
  // "not_configured" result (docs/tools.md) requires `ctx.calendar` itself to be null when
  // unconfigured, not a sync wrapper around a null client (see calendar/sync.ts's `upsert`,
  // which instead reports `pending` for an item the index hasn't caught up to yet — the case
  // for every freshly-captured appointment, since reindexing happens after the whole capture
  // batch, not per item).
  const calendar =
    calendarClient !== null
      ? createCalendarSync({
          client: calendarClient,
          state,
          index,
          zone: () => index.settings().settings.timeZone,
          log,
        })
      : null;

  const accessVerifier = createAccessVerifier({
    teamDomain: config.access.teamDomain ?? undefined,
    audience: config.access.audience ?? undefined,
    ownerEmail: config.ownerEmail ?? undefined,
    jwks: opts.accessJwks,
  });

  let scheduleRefresh: () => void = () => {};
  const ctx: ClaudiaContext = {
    vaultDir: config.vaultPath,
    vaultName: config.vaultName,
    publicUrl: config.publicUrl,
    clock,
    index,
    state,
    writer,
    notifier,
    calendar,
    actionKey,
    log,
    onVaultChanged: () => {
      scheduleRefresh();
    },
  };
  const refresher = createGeneratedRefresher(ctx);
  scheduleRefresh = () => {
    refresher.schedule();
  };

  // --- vault watcher: reindex changed notes, merge iCloud conflict copies, assign missing ids ---

  async function onChanges(paths: string[]): Promise<void> {
    if (stopped) return;
    const conflictPaths = paths.filter((p) => conflictCopyBase(p) !== null);
    const normalPaths = paths.filter((p) => conflictCopyBase(p) === null);

    if (conflictPaths.length > 0) {
      const reports = await runJanitor({
        vaultDir: config.vaultPath,
        writer,
        relPaths: conflictPaths,
      });
      for (const report of reports) {
        await appendLog(ctx, {
          surface: 'janitor',
          verb: 'merged conflict copy',
          path: report.original,
          details: ` (${report.copy})`,
        });
      }
    }

    for (const p of normalPaths) {
      await index.reindexFile(p);
    }

    const idAssignPaths = [
      ...normalPaths,
      ...conflictPaths.map((p) => conflictCopyBase(p)).filter((p): p is string => p !== null),
    ];
    await assignMissingIds({
      writer,
      vaultDir: config.vaultPath,
      relPaths: idAssignPaths,
      hasId: (id) => index.hasId(id),
    });

    refresher.schedule();
  }

  async function onRescan(): Promise<void> {
    if (stopped) return;
    await index.refresh();
    const reports = await runJanitor({ vaultDir: config.vaultPath, writer });
    for (const report of reports) {
      await appendLog(ctx, {
        surface: 'janitor',
        verb: 'merged conflict copy',
        path: report.original,
        details: ` (${report.copy})`,
      });
    }
    refresher.schedule();
  }

  // Watch the vault only once it is readable (see startRebuild).
  let watcher: Watcher | null = null;
  onVaultReady = () => {
    refresher.schedule();
    if (opts.watch !== false && !watcher && !stopped) {
      watcher = createWatcher({ vaultDir: config.vaultPath, onChanges, onRescan });
      watcher.start();
    }
  };
  if (vaultReady) onVaultReady();

  // --- HTTP: OAuth authorization server, bearer-guarded /mcp, /health -----------------------

  const oauthRouter = createOAuthRouter({
    publicUrl: config.publicUrl,
    store: oauthStore,
    access: accessVerifier,
    signingKey: oauthKey,
    now: () => clock.now(),
  });
  const bearer = requireBearer({ store: oauthStore, publicUrl: config.publicUrl });

  const healthDeps: HealthDeps = {
    vaultPath: config.vaultPath,
    ntfyConfigured: notifier !== null,
    calendarConfigured: calendarClient !== null,
  };
  const health = createHealth(ctx, healthDeps);

  const mcp = createMcpHandler(ctx);

  const app = createHttpApp({
    publicUrl: config.publicUrl,
    oauthRouter,
    bearer,
    health,
    mcp,
    actions: createActionsRouter(ctx),
  });
  for (const router of opts.extraRouters ?? []) {
    app.use(router);
  }

  const background = opts.startBackground ? opts.startBackground(ctx) : null;

  let server: Server | null = null;
  let url = config.publicUrl;

  if (opts.listen !== false) {
    const listenPort = opts.port0 ? 0 : config.port;
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(listenPort, config.host, () => {
        resolve(s);
      });
      s.on('error', reject);
    });
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : config.port;
    url = `http://${config.host}:${String(actualPort)}`;
  }

  // Reminders, nudges, the brief fallback and nightly jobs. The first tick runs right away, which is
  // the downtime catch-up. Calendar events are reconciled once at start so appointments captured
  // before the calendar was configured get their events.
  const scheduler = createScheduler(ctx, { backupsDir: config.paths.backupsDir });
  if (opts.schedulerAutoStart !== false) {
    scheduler.start();
    if (ctx.calendar) void ctx.calendar.reconcile();
  }

  async function stop(): Promise<void> {
    stopped = true;
    scheduler.stop();
    if (rebuildRetryTimer) {
      clearTimeout(rebuildRetryTimer);
      rebuildRetryTimer = null;
    }
    watcher?.stop();
    refresher.stop();
    background?.stop();
    if (server) {
      const s = server;
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    index.close();
    state.close();
  }

  return { ctx, url, scheduler, stop };
}
