import type { Clock } from '../clock.ts';
import type { Index } from '../engine/index.ts';
import type { State } from '../engine/state.ts';
import type { VaultWriter } from '../engine/writer.ts';
import type { Notifier } from '../notify/ntfy.ts';
import { formatNow, instantToLocal, localDate } from '../time/format.ts';
import type { Settings } from '../vault/settings.ts';

export type CalendarStatus = 'created' | 'updated' | 'pending' | 'not_configured';

/** Keeps Claudia-calendar events in step with appointment lines (src/calendar/sync.ts). */
export interface CalendarSync {
  upsert(id: string): Promise<CalendarStatus>;
  cancel(id: string): Promise<void>;
  reconcile(): Promise<void>;
}

/** Everything a service needs. Built once by main.ts, and by tests/helpers/test-context.ts in tests. */
export interface ClaudiaContext {
  vaultDir: string;
  vaultName: string;
  publicUrl: string;
  clock: Clock;
  index: Index;
  state: State;
  writer: VaultWriter;
  notifier: Notifier | null;
  calendar: CalendarSync | null;
  actionKey: Buffer;
  /** Operational log (stderr / service log file). Never the vault, never secrets. */
  log: (message: string) => void;
  /** Called after any vault change the services make, e.g. to schedule a Today refresh. */
  onVaultChanged: () => void;
}

export function currentSettings(ctx: ClaudiaContext): Settings {
  return ctx.index.settings().settings;
}

export function zoneOf(ctx: ClaudiaContext): string {
  return currentSettings(ctx).timeZone;
}

/** Today's local date, 'YYYY-MM-DD'. */
export function todayOf(ctx: ClaudiaContext): string {
  return localDate(ctx.clock.now(), zoneOf(ctx));
}

/** Now as local 'YYYY-MM-DD HH:mm'. */
export function nowLocalOf(ctx: ClaudiaContext): string {
  return instantToLocal(ctx.clock.now(), zoneOf(ctx));
}

/** Now as the `now` field every tool result carries: 'YYYY-MM-DD HH:mm Ddd'. */
export function nowLabel(ctx: ClaudiaContext): string {
  return formatNow(ctx.clock.now(), zoneOf(ctx));
}

/** Re-index the notes a service just wrote so the next call sees them, then notify listeners. */
export async function afterWrite(ctx: ClaudiaContext, relPaths: Iterable<string>): Promise<void> {
  for (const p of new Set(relPaths)) {
    await ctx.index.reindexFile(p);
  }
  ctx.onVaultChanged();
}
