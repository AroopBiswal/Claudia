// Generated notes (vault-format.md section 5 "Today.md" / "Recently
// captured.md"): render the two Claudia-owned notes and rewrite them on the
// vault. Never calls afterWrite/onVaultChanged: these notes carry no items
// (extractItems skips `claudia: generated` notes) and rewriting them is
// itself triggered by onVaultChanged, so looping back into it here would
// recurse forever.

import type { IndexedItem } from '../engine/index.ts';
import { LAYOUT, wikiLink } from '../vault/layout.ts';
import { GENERATED_HEADER } from '../vault/templates.ts';
import { addDays, formatLongDate } from '../time/format.ts';
import { nowLocalOf, todayOf, type ClaudiaContext } from './context.ts';
import { nudgesDue } from './nudges.ts';
import { recentCaptures } from './recent.ts';

function bulletsOrNothing(lines: string[]): string {
  return lines.length > 0 ? lines.join('\n') : '- Nothing.';
}

function link(item: IndexedItem): string {
  return wikiLink(item.path, item.id ?? undefined, item.text);
}

function appointmentLine(item: IndexedItem): string {
  const appt = item.appointment;
  const time = appt ? (appt.end ? `${appt.start}-${appt.end}` : appt.start) : '';
  return `- ${time} ${link(item)}`;
}

function reminderLine(item: IndexedItem): string {
  const time = (item.effectiveReminder ?? '').slice(11);
  return `- ${time} ${link(item)}`;
}

function plainLine(item: IndexedItem): string {
  return `- ${link(item)}`;
}

function keyOf(item: IndexedItem): string {
  return item.id ?? `${item.path}:${item.lineNo}`;
}

/** Renders Today.md exactly per vault-format.md section 5. Synchronous: no disk reads. */
export function renderToday(ctx: ClaudiaContext): string {
  const today = todayOf(ctx);
  const nowLocal = nowLocalOf(ctx);
  const yesterday = addDays(today, -1);

  const appointments = ctx.index.appointments({ from: today, to: today });
  const reminders = ctx.index.openReminders({ from: `${today} 00:00`, to: `${today} 23:59` });
  const dueToday = ctx.index.openDue({ from: today, to: today }).filter((i) => i.kind === 'task');

  const overdueReminders = ctx.index.openReminders({ to: nowLocal });
  const overdueDue = ctx.index.openDue({ to: yesterday });
  const overdueLines: string[] = [];
  const overdueSeen = new Set<string>();
  for (const item of overdueReminders) {
    const key = keyOf(item);
    if (overdueSeen.has(key)) continue;
    overdueSeen.add(key);
    overdueLines.push(`- ⏰ ${item.effectiveReminder ?? ''} ${link(item)}`);
  }
  for (const item of overdueDue) {
    const key = keyOf(item);
    if (overdueSeen.has(key)) continue;
    overdueSeen.add(key);
    overdueLines.push(`- 📅 ${item.due ?? ''} ${link(item)}`);
  }

  const nudgeItems = nudgesDue(ctx).map((n) => n.item);
  const followUpDueToday = ctx.index.followUps().filter((f) => f.due === today);
  const followUpLines: string[] = [];
  const followUpSeen = new Set<string>();
  for (const item of [...nudgeItems, ...followUpDueToday]) {
    const key = keyOf(item);
    if (followUpSeen.has(key)) continue;
    followUpSeen.add(key);
    followUpLines.push(plainLine(item));
  }

  const staleFacts = ctx.index.staleFacts(today);
  const staleLines = staleFacts.map((item) => `- ${link(item)} ⌛ ${item.expires ?? ''}`);

  const brief = ctx.state.getKv(`today-summary:${today}`) ?? 'No brief yet today.';

  const sections = [
    `# Today · ${formatLongDate(today)}`,
    `## Brief\n${brief}`,
    `## Appointments\n${bulletsOrNothing(appointments.map(appointmentLine))}`,
    `## Reminders\n${bulletsOrNothing(reminders.map(reminderLine))}`,
    `## Due today\n${bulletsOrNothing(dueToday.map(plainLine))}`,
    `## Overdue\n${bulletsOrNothing(overdueLines)}`,
    `## Follow-ups\n${bulletsOrNothing(followUpLines)}`,
    `## Stale facts\n${bulletsOrNothing(staleLines)}`,
  ];

  return `${GENERATED_HEADER}\n${sections.join('\n\n')}\n`;
}

/** Renders Recently captured.md exactly per vault-format.md section 5. */
export async function renderRecent(ctx: ClaudiaContext): Promise<string> {
  const captures = await recentCaptures(ctx, 7);

  const bodyLines: string[] = [];
  if (captures.length === 0) {
    bodyLines.push('- Nothing captured in the last 7 days.');
  } else {
    let currentDate: string | null = null;
    for (const c of captures) {
      if (c.date !== currentDate) {
        if (currentDate !== null) bodyLines.push('');
        bodyLines.push(`## ${formatLongDate(c.date)}`);
        currentDate = c.date;
      }
      const detailsPart = c.details ? ` ${c.details}` : '';
      bodyLines.push(
        `- ${c.time} · ${wikiLink(c.note, c.id, c.text)}${detailsPart} · ${c.surface}`,
      );
    }
  }

  return `${GENERATED_HEADER}\n# Recently captured\n\n${bodyLines.join('\n')}\n`;
}

/** Rewrites Today.md and Recently captured.md. Returns whether each note's content changed. */
export async function refreshGenerated(
  ctx: ClaudiaContext,
): Promise<{ today: boolean; recent: boolean }> {
  const todayContent = renderToday(ctx);
  const recentContent = await renderRecent(ctx);
  const today = await ctx.writer.rewrite(LAYOUT.today, todayContent);
  const recent = await ctx.writer.rewrite(LAYOUT.recent, recentContent);
  return { today, recent };
}

export interface GeneratedRefresherOptions {
  /** Debounce window; default 2000ms. */
  debounceMs?: number;
  /** Injectable timer, default global setTimeout (tests use a fake). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Injectable timer cancel, default global clearTimeout. */
  clearTimer?: (handle: unknown) => void;
}

export interface GeneratedRefresher {
  /** (Re)starts the debounce window; a refresh runs once it elapses without another call. */
  schedule(): void;
  /** Runs a pending (scheduled or in-flight) refresh immediately, and waits for it. No-op if none. */
  flush(): Promise<void>;
  /** Cancels any pending scheduled refresh without running it. */
  stop(): void;
}

/** Debounces refreshGenerated calls so a burst of vault changes only rewrites the notes once. */
export function createGeneratedRefresher(
  ctx: ClaudiaContext,
  opts: GeneratedRefresherOptions = {},
): GeneratedRefresher {
  const debounceMs = opts.debounceMs ?? 2000;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));

  let handle: unknown = null;
  let pending: Promise<void> | null = null;

  function runNow(): Promise<void> {
    const p = refreshGenerated(ctx)
      .then(() => undefined)
      .catch((err: unknown) => {
        ctx.log(`generated refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    pending = p;
    return p;
  }

  function schedule(): void {
    if (handle !== null) clearTimer(handle);
    handle = setTimer(() => {
      handle = null;
      void runNow();
    }, debounceMs);
  }

  async function flush(): Promise<void> {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
      await runNow();
      return;
    }
    if (pending) {
      await pending;
    }
  }

  function stop(): void {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  }

  return { schedule, flush, stop };
}
