// GET /health (docs/tools.md, no auth): a small, cached snapshot of service
// health. Never includes paths, emails, tokens or note content.

import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ClaudiaContext } from './services/context.ts';
import { VERSION } from './version.ts';

export interface HealthDeps {
  /** The vault directory to probe for readability/writability. Never included in the report. */
  vaultPath: string;
  /** Whether a push notifier is wired up (ntfy topic set and its token file exists). */
  ntfyConfigured: boolean;
  /** Whether a Google Calendar client is wired up (client secrets and token files both exist). */
  calendarConfigured: boolean;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  vault: { path_ok: boolean; writable: boolean };
  index: { items: number; notes: number; last_rebuild: string | null };
  scheduler: { last_tick: string | null };
  ntfy: { configured: boolean };
  calendar: { configured: boolean };
  settings_warnings: string[];
}

const CACHE_MS = 2000;

async function pathReadable(vaultPath: string): Promise<boolean> {
  try {
    await readdir(vaultPath);
    return true;
  } catch {
    return false;
  }
}

async function pathWritable(vaultPath: string): Promise<boolean> {
  try {
    await access(vaultPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function checkVault(vaultPath: string): Promise<{ path_ok: boolean; writable: boolean }> {
  const pathOk = await pathReadable(vaultPath);
  const writable = pathOk && (await pathWritable(vaultPath));
  return { path_ok: pathOk, writable };
}

/** Builds a cached (2s) health snapshot function for GET /health. */
export function createHealth(ctx: ClaudiaContext, deps: HealthDeps): () => Promise<HealthReport> {
  let cached: { at: number; report: HealthReport } | null = null;

  return async function health(): Promise<HealthReport> {
    const now = ctx.clock.now().getTime();
    if (cached && now - cached.at < CACHE_MS) {
      return cached.report;
    }

    const vault = await checkVault(deps.vaultPath);
    const stats = ctx.index.stats();
    const lastTick = ctx.state.getKv('scheduler:last_tick');
    const settingsWarnings = ctx.index.settings().warnings;

    const report: HealthReport = {
      status: vault.path_ok && vault.writable ? 'ok' : 'degraded',
      version: VERSION,
      vault,
      index: { items: stats.items, notes: stats.notes, last_rebuild: stats.lastRebuild },
      scheduler: { last_tick: lastTick },
      ntfy: { configured: deps.ntfyConfigured },
      calendar: { configured: deps.calendarConfigured },
      settings_warnings: settingsWarnings,
    };

    cached = { at: now, report };
    return report;
  };
}
