// Follow-up nudges (vault-format.md section 7, Decision Log B7): computes
// when a `#waiting` / `#promised` follow-up is next due for a nudge, and
// which open follow-ups are due for one right now and haven't fired yet.

import type { IndexedItem } from '../engine/index.ts';
import { addDays, type LocalDate, type LocalDateTime } from '../time/format.ts';
import type { Settings } from '../vault/settings.ts';
import { currentSettings, nowLocalOf, todayOf, type ClaudiaContext } from './context.ts';

export interface NudgeDue {
  item: IndexedItem;
  /** 'YYYY-MM-DD HH:mm' local: when the nudge fires. */
  dueLocal: LocalDateTime;
  /** State key for Index/State.wasFired/markFired: 'nudge:<id>:<date>'. */
  key: string;
}

function daysBetween(from: LocalDate, to: LocalDate): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const a = Date.UTC(fy ?? 0, (fm ?? 1) - 1, fd ?? 1);
  const b = Date.UTC(ty ?? 0, (tm ?? 1) - 1, td ?? 1);
  return Math.round((b - a) / 86_400_000);
}

/**
 * The most recent nudge moment on or before `today` for this follow-up, or
 * null when no nudge applies (vault-format.md section 7):
 * - not an open follow-up: null
 * - carries a ⏰ reminder: null (the reminder replaces nudges)
 * - has 📅: one nudge on that date at the nudge time, once its date has come
 * - no 📅 but has ➕: a nudge `waitingNudgeDays` after ➕, then every that
 *   many days while open (the latest such occurrence not after `today`)
 * - neither 📅 nor ➕: null
 */
export function nudgeTimeFor(
  item: IndexedItem,
  settings: Settings,
  today: LocalDate,
): LocalDateTime | null {
  if (item.kind !== 'follow_up') return null;
  if (item.status !== 'open') return null;
  if (item.reminder) return null;

  if (item.due) {
    return item.due <= today ? `${item.due} ${settings.nudgeTime}` : null;
  }

  if (!item.created) return null;

  const n = settings.waitingNudgeDays;
  if (n <= 0) return null;

  const elapsed = daysBetween(item.created, today);
  if (elapsed < n) return null;

  const occurrences = Math.floor(elapsed / n);
  const nudgeDate = addDays(item.created, occurrences * n);
  return `${nudgeDate} ${settings.nudgeTime}`;
}

/** Open follow-ups whose latest nudge moment has passed and whose key hasn't fired yet. */
export function nudgesDue(ctx: ClaudiaContext, opts?: { nowLocal?: LocalDateTime }): NudgeDue[] {
  const settings = currentSettings(ctx);
  const today = todayOf(ctx);
  const nowLocal = opts?.nowLocal ?? nowLocalOf(ctx);

  const due: NudgeDue[] = [];
  for (const item of ctx.index.followUps()) {
    const dueLocal = nudgeTimeFor(item, settings, today);
    if (dueLocal === null) continue;
    if (dueLocal > nowLocal) continue;

    const key = `nudge:${item.id ?? ''}:${dueLocal.slice(0, 10)}`;
    if (ctx.state.wasFired(key)) continue;

    due.push({ item, dueLocal, key });
  }
  return due;
}
