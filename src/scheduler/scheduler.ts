// The scheduler (docs/PLAN.md "Reminders", "After downtime", "Morning brief
// fallback"; vault-format.md section 7): a single tick, run on an interval,
// that fires due reminders (with downtime catch-up and bundling), sends
// follow-up nudges, sends the brief fallback push, rewrites the generated
// notes at local midnight, and runs the nightly archive/backup/maintenance
// job. Every step is independent and never throws out of tick(); a failing
// step is recorded in TickReport.errors and does not stop the others.

import { archiveCompleted } from '../engine/archive.ts';
import { runBackup } from '../engine/backup.ts';
import type { IndexedItem } from '../engine/index.ts';
import { agenda } from '../services/agenda.ts';
import {
  afterWrite,
  currentSettings,
  nowLocalOf,
  todayOf,
  zoneOf,
  type ClaudiaContext,
} from '../services/context.ts';
import { refreshGenerated } from '../services/generated.ts';
import { appendLog } from '../services/log.ts';
import { nudgesDue } from '../services/nudges.ts';
import { LAYOUT, obsidianUri } from '../vault/layout.ts';
import { bundlePush, reminderPush, type PushMessage } from '../notify/ntfy.ts';
import { actionUrl, signActionLink } from '../notify/links.ts';
import { localToInstant } from '../time/format.ts';

export interface TickReport {
  /** Reminder ids sent individually this tick. */
  fired: string[];
  /** Reminder ids sent as part of a downtime bundle this tick. */
  bundled: string[];
  /** Follow-up ids nudged this tick. */
  nudged: string[];
  /** Whether the brief fallback push was sent this tick. */
  fallback: boolean;
  /** Whether the nightly job ran this tick. */
  nightly: boolean;
  /** Whether Today/Recently captured were rewritten for a new local day this tick. */
  dayRolled: boolean;
  /** One message per step that threw or reported a problem; never throws. */
  errors: string[];
}

export interface Scheduler {
  /** Runs one tick immediately (downtime catch-up), then every tickMs. */
  start(): void;
  stop(): void;
  tick(): Promise<TickReport>;
}

export interface CreateSchedulerOptions {
  backupsDir: string;
  /** Default 30_000. */
  tickMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** Local hour the nightly job may start at; default 3. */
  nightlyHour?: number;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_NIGHTLY_HOUR = 3;
const LATE_MS = 5 * 60_000;
const CATCHUP_WINDOW_MS = 2 * 60 * 60_000;
const BRIEF_FALLBACK_WINDOW_MS = 6 * 60 * 60_000;
const MAX_BUNDLE_ITEMS = 15;
const NIGHTLY_PRUNE_DAYS = 60;

function emptyReport(): TickReport {
  return {
    fired: [],
    bundled: [],
    nudged: [],
    fallback: false,
    nightly: false,
    dayRolled: false,
    errors: [],
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// vault-format.md 4.3: tags and links stay in the description, so a
// follow-up's text carries "#waiting"/"#promised" and any [[links]]. Push
// messages are plain text (not rendered by Obsidian), so both are stripped;
// a Log line label goes through wikiLink instead, which unwraps links on
// its own, but stripping here too is harmless (no brackets are left to find).
const TAG_RE = /(?<![\p{L}\p{N}_])#[\p{L}\p{N}_/-]+/gu;
const WIKILINK_RE = /\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

function plainText(text: string): string {
  return text
    .replace(WIKILINK_RE, (_m, target: string, alias?: string) => alias ?? target)
    .replace(TAG_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface PendingReminder {
  item: IndexedItem;
  id: string;
  effective: string;
  key: string;
  fireInstant: Date;
}

/** Step a: fires due reminders, sending late ones individually and stale ones in one bundle. */
async function runReminders(ctx: ClaudiaContext, report: TickReport): Promise<void> {
  const nowDate = ctx.clock.now();
  const zone = zoneOf(ctx);
  const nowLocal = nowLocalOf(ctx);

  const candidates = ctx.index.openReminders({ to: nowLocal });

  const pending: PendingReminder[] = [];
  for (const item of candidates) {
    if (item.id === null || item.effectiveReminder === null) continue;
    const id = item.id;
    const effective = item.effectiveReminder;
    const key = `reminder:${id}:${effective}`;
    if (ctx.state.wasFired(key)) continue;
    const fireInstant = localToInstant(effective, zone);
    pending.push({ item, id, effective, key, fireInstant });
  }

  if (pending.length === 0) return;

  if (!ctx.notifier) {
    report.errors.push('reminders: no notifier configured');
    return;
  }
  const notifier = ctx.notifier;

  const cutoffMs = nowDate.getTime() - CATCHUP_WINDOW_MS;
  const individual = pending.filter((p) => p.fireInstant.getTime() >= cutoffMs);
  const bundle = pending.filter((p) => p.fireInstant.getTime() < cutoffMs);

  for (const p of individual) {
    const late = nowDate.getTime() - p.fireInstant.getTime() > LATE_MS;
    const push = reminderPush({
      id: p.id,
      text: plainText(p.item.text),
      notePath: p.item.path,
      fireLocal: p.effective,
      vaultName: ctx.vaultName,
      publicUrl: ctx.publicUrl,
      key: ctx.actionKey,
      now: nowDate,
      late,
    });
    try {
      const result = await notifier.send(push);
      if (result.ok) {
        ctx.state.markFired(p.key, 'reminder');
        report.fired.push(p.id);
      } else {
        report.errors.push(`reminder ${p.id}: ${result.error}`);
      }
    } catch (err) {
      report.errors.push(`reminder ${p.id}: ${errMsg(err)}`);
    }
  }

  if (bundle.length > 0) {
    const shown = bundle.slice(0, MAX_BUNDLE_ITEMS);
    const extra = bundle.length - shown.length;
    const push = bundlePush({
      items: shown.map((p) => ({ id: p.id, text: plainText(p.item.text), fireLocal: p.effective })),
      vaultName: ctx.vaultName,
    });
    if (extra > 0) push.message += `\nand ${extra} more.`;
    try {
      const result = await notifier.send(push);
      if (result.ok) {
        for (const p of bundle) {
          ctx.state.markFired(p.key, 'bundle');
          report.bundled.push(p.id);
        }
      } else {
        report.errors.push(`reminder bundle: ${result.error}`);
      }
    } catch (err) {
      report.errors.push(`reminder bundle: ${errMsg(err)}`);
    }
  }
}

/** Step b: pushes one notification per follow-up whose nudge moment has passed. */
async function runNudges(ctx: ClaudiaContext, report: TickReport): Promise<void> {
  if (!ctx.notifier) return;
  const notifier = ctx.notifier;

  const due = nudgesDue(ctx);
  const nowDate = ctx.clock.now();

  for (const n of due) {
    const item = n.item;
    if (item.id === null) continue;
    const id = item.id;

    const doneToken = signActionLink(ctx.actionKey, { action: 'done', id, now: nowDate });
    const tomorrowToken = signActionLink(ctx.actionKey, { action: 'tomorrow', id, now: nowDate });

    const push: PushMessage = {
      title: 'Follow-up',
      message: plainText(item.text),
      priority: 'default',
      click: obsidianUri(ctx.vaultName, item.path, id),
      actions: [
        { label: 'Done', url: actionUrl(ctx.publicUrl, doneToken), method: 'POST', clear: true },
        {
          label: 'Tomorrow',
          url: actionUrl(ctx.publicUrl, tomorrowToken),
          method: 'POST',
          clear: true,
        },
      ],
    };

    try {
      const result = await notifier.send(push);
      if (result.ok) {
        ctx.state.markFired(n.key, 'nudge');
        await appendLog(ctx, {
          surface: 'Claudia',
          verb: 'nudged',
          path: item.path,
          id,
          text: plainText(item.text),
        });
        report.nudged.push(id);
      } else {
        report.errors.push(`nudge ${id}: ${result.error}`);
      }
    } catch (err) {
      report.errors.push(`nudge ${id}: ${errMsg(err)}`);
    }
  }
}

/** Step c: the server's own brief push when Claude's morning brief hasn't shown up. */
async function runBriefFallback(ctx: ClaudiaContext, report: TickReport): Promise<void> {
  if (!ctx.notifier) return;
  const notifier = ctx.notifier;

  const settings = currentSettings(ctx);
  const zone = zoneOf(ctx);
  const today = todayOf(ctx);
  const nowMs = ctx.clock.now().getTime();

  const briefMomentMs = localToInstant(`${today} ${settings.briefTime}`, zone).getTime();
  const fallbackMomentMs = briefMomentMs + settings.briefFallbackMinutes * 60_000;
  const windowEndMs = fallbackMomentMs + BRIEF_FALLBACK_WINDOW_MS;

  if (nowMs < fallbackMomentMs || nowMs >= windowEndMs) return;
  if (ctx.state.wasFired(`brief:${today}`)) return;
  if (ctx.state.wasFired(`fallback:${today}`)) return;

  const result = await agenda(ctx, { view: 'brief' });
  if ('error' in result || result.view !== 'brief') {
    report.errors.push(`brief fallback: ${'error' in result ? result.error : 'unexpected view'}`);
    return;
  }

  const appointments = result.counts.appointments_today ?? 0;
  const reminders = result.counts.reminders_today ?? 0;
  const overdue = (result.counts.overdue_reminders ?? 0) + (result.counts.overdue_due ?? 0);
  const nudges = result.counts.nudges_due ?? 0;

  const parts: string[] = [];
  if (appointments > 0) parts.push(`${appointments} appointment${appointments === 1 ? '' : 's'}`);
  if (reminders > 0) parts.push(`${reminders} reminder${reminders === 1 ? '' : 's'}`);
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (nudges > 0) parts.push(`${nudges} follow-up${nudges === 1 ? '' : 's'} to nudge`);
  const message = parts.length > 0 ? `Today: ${parts.join(', ')}.` : 'Nothing scheduled today.';

  const push: PushMessage = {
    title: 'Claudia brief',
    message,
    priority: 'default',
    click: obsidianUri(ctx.vaultName, LAYOUT.today),
  };

  try {
    const sendResult = await notifier.send(push);
    if (sendResult.ok) {
      ctx.state.markFired(`fallback:${today}`, 'fallback');
      report.fallback = true;
    } else {
      report.errors.push(`brief fallback: ${sendResult.error}`);
    }
  } catch (err) {
    report.errors.push(`brief fallback: ${errMsg(err)}`);
  }
}

/** Step d: rewrites Today.md / Recently captured.md once per new local day. */
async function runDayRollover(ctx: ClaudiaContext, report: TickReport): Promise<void> {
  const today = todayOf(ctx);
  if (ctx.state.getKv('scheduler:day') === today) return;
  await refreshGenerated(ctx);
  ctx.state.setKv('scheduler:day', today);
  report.dayRolled = true;
}

/** Step e: nightly archive, backup, state prune, calendar reconcile and index refresh. */
async function runNightly(
  ctx: ClaudiaContext,
  opts: { backupsDir: string; nightlyHour: number },
  report: TickReport,
): Promise<void> {
  const hour = Number(nowLocalOf(ctx).slice(11, 13));
  if (hour < opts.nightlyHour) return;

  const today = todayOf(ctx);
  const key = `nightly:${today}`;
  if (ctx.state.getKv(key) !== null) return;

  const archived = await archiveCompleted({ writer: ctx.writer, today });

  const touched = new Set<string>([LAYOUT.appointments]);
  for (const a of archived) {
    touched.add(a.from);
    touched.add(a.to);
  }
  await afterWrite(ctx, touched);

  for (const a of archived) {
    const item = a.id !== null ? ctx.index.getItem(a.id) : null;
    await appendLog(ctx, {
      surface: 'Claudia',
      verb: 'archived',
      path: a.to,
      id: a.id ?? undefined,
      text: item ? plainText(item.text) : undefined,
    });
  }

  await runBackup({ vaultDir: ctx.vaultDir, backupsDir: opts.backupsDir, today });
  ctx.state.prune(NIGHTLY_PRUNE_DAYS);
  if (ctx.calendar) {
    await ctx.calendar.reconcile();
  }
  await ctx.index.refresh();

  ctx.state.setKv(key, ctx.clock.now().toISOString());
  report.nightly = true;
}

async function runStep(report: TickReport, label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    report.errors.push(`${label}: ${errMsg(err)}`);
  }
}

export function createScheduler(ctx: ClaudiaContext, opts: CreateSchedulerOptions): Scheduler {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const nightlyHour = opts.nightlyHour ?? DEFAULT_NIGHTLY_HOUR;
  const doSetInterval = opts.setInterval ?? setInterval;
  const doClearInterval = opts.clearInterval ?? clearInterval;

  let handle: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick(): Promise<TickReport> {
    if (running) return emptyReport();
    running = true;
    const report = emptyReport();
    try {
      await runStep(report, 'reminders', () => runReminders(ctx, report));
      await runStep(report, 'nudges', () => runNudges(ctx, report));
      await runStep(report, 'brief fallback', () => runBriefFallback(ctx, report));
      await runStep(report, 'day rollover', () => runDayRollover(ctx, report));
      await runStep(report, 'nightly', () =>
        runNightly(ctx, { backupsDir: opts.backupsDir, nightlyHour }, report),
      );
      ctx.state.setKv('scheduler:last_tick', ctx.clock.now().toISOString());
    } finally {
      running = false;
    }
    return report;
  }

  function start(): void {
    void tick();
    handle = doSetInterval(() => {
      void tick();
    }, tickMs);
  }

  function stop(): void {
    if (handle !== null) {
      doClearInterval(handle);
      handle = null;
    }
  }

  return { start, stop, tick };
}
