import rrulePkg from 'rrule';
import type { Options } from 'rrule';
import { addDays, type LocalDate, type LocalDateTime } from '../time/format.ts';

const { RRule } = rrulePkg;

export interface RepeatRule {
  text: string;
  whenDone: boolean;
  valid: boolean;
}

const WHEN_DONE_RE = /\s+when done\s*$/i;

function splitWhenDone(text: string): { ruleText: string; whenDone: boolean } {
  const trimmed = text.trim();
  const match = WHEN_DONE_RE.exec(trimmed);
  if (match) {
    return { ruleText: trimmed.slice(0, match.index).trim(), whenDone: true };
  }
  return { ruleText: trimmed, whenDone: false };
}

function parseOptions(ruleText: string): Partial<Options> | null {
  if (ruleText.length === 0) return null;
  try {
    // RRule.fromText always returns a rule (defaulting to "every year" on
    // garbage input); RRule.parseText is the strict form that returns null
    // when it can't find a recognizable rule, and throws on tokens it can't
    // parse at all (e.g. "every blue moon"). Its .d.ts return type omits the
    // null case, so the runtime null check below is load-bearing.
    const parsed: Partial<Options> | null = RRule.parseText(ruleText);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Restricts to the families vault-format.md section 7 documents: daily, every N
 * days, weekly, every N weeks, weekly on a weekday list, every weekday, monthly,
 * monthly on the Nth, yearly. Rejects everything rrule's text parser accepts
 * beyond that (hourly, nth-weekday-of-month, count/until horizons, etc).
 */
function isSupportedFamily(opts: Partial<Options> | null): boolean {
  if (opts === null || opts.freq === undefined) return false;
  if (opts.count != null || opts.until != null) return false;
  if (opts.byyearday != null || opts.byweekno != null || opts.bysetpos != null) return false;
  if (opts.byhour != null || opts.byminute != null || opts.bysecond != null) return false;

  switch (opts.freq) {
    case RRule.DAILY:
      return opts.byweekday == null && opts.bymonthday == null && opts.bymonth == null;
    case RRule.WEEKLY: {
      if (opts.bymonthday != null || opts.bymonth != null) return false;
      if (opts.byweekday == null) return true;
      const days = Array.isArray(opts.byweekday) ? opts.byweekday : [opts.byweekday];
      return days.every(
        (w) => typeof w === 'object' && w !== null && (w as { n?: number }).n == null,
      );
    }
    case RRule.MONTHLY: {
      if (opts.interval !== undefined && opts.interval !== 1) return false;
      if (opts.byweekday != null || opts.bymonth != null) return false;
      if (opts.bymonthday == null) return true;
      return Array.isArray(opts.bymonthday) ? opts.bymonthday.length === 1 : true;
    }
    case RRule.YEARLY:
      if (opts.interval !== undefined && opts.interval !== 1) return false;
      return opts.byweekday == null;
    default:
      return false;
  }
}

/**
 * Parses the 🔁 field text. `text` minus a trailing "when done" is handed to
 * rrule's text parser; `valid` is true only when that parses into one of the
 * supported repeat families.
 */
export function parseRepeat(text: string): RepeatRule {
  const { ruleText, whenDone } = splitWhenDone(text);
  const opts = parseOptions(ruleText);
  return { text, whenDone, valid: isSupportedFamily(opts) };
}

function toFloatingUtc(date: LocalDate): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
}

function fromFloatingUtc(d: Date): LocalDate {
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * First occurrence of `rule` strictly after `anchor` (or, when `rule.whenDone`,
 * strictly after `today`) that is not before `today`. Dates are treated as
 * floating (UTC midnight) so DST never shifts a date. Null when `rule` is
 * invalid or has no further occurrence.
 */
export function nextAnchor(
  rule: RepeatRule,
  anchor: LocalDate,
  today: LocalDate,
): LocalDate | null {
  if (!rule.valid) return null;
  const { ruleText } = splitWhenDone(rule.text);
  const opts = parseOptions(ruleText);
  if (opts === null) return null;

  const dtstart = toFloatingUtc(anchor);
  const todayUtc = toFloatingUtc(today);
  const rrule = new RRule({ ...opts, dtstart });

  const base = rule.whenDone ? todayUtc : dtstart;
  let occurrence = rrule.after(base, false);
  while (occurrence !== null && occurrence.getTime() < todayUtc.getTime()) {
    occurrence = rrule.after(occurrence, false);
  }
  return occurrence === null ? null : fromFloatingUtc(occurrence);
}

function shiftLocalDateTime(local: LocalDateTime, deltaDays: number): LocalDateTime {
  const date = local.slice(0, 10);
  const time = local.slice(11);
  return `${addDays(date, deltaDays)} ${time}`;
}

function diffDays(from: LocalDate, to: LocalDate): number {
  const a = toFloatingUtc(from).getTime();
  const b = toFloatingUtc(to).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Shifts the vault-format fields of a completed repeating item to their next
 * occurrence. anchor = due if present, else the reminder's date (null if
 * neither is present, in which case this returns null). Every present field
 * shifts by the same number of days; the reminder keeps its time of day.
 */
export function nextRepeatFields(
  fields: {
    reminder?: string | null;
    due?: string | null;
    scheduled?: string | null;
    start?: string | null;
  },
  rule: RepeatRule,
  today: LocalDate,
): { reminder?: string; due?: string; scheduled?: string; start?: string } | null {
  const anchor = fields.due ?? (fields.reminder ? fields.reminder.slice(0, 10) : null);
  if (anchor === null) return null;

  const next = nextAnchor(rule, anchor, today);
  if (next === null) return null;

  const deltaDays = diffDays(anchor, next);
  const result: { reminder?: string; due?: string; scheduled?: string; start?: string } = {};
  if (fields.reminder) result.reminder = shiftLocalDateTime(fields.reminder, deltaDays);
  if (fields.due) result.due = addDays(fields.due, deltaDays);
  if (fields.scheduled) result.scheduled = addDays(fields.scheduled, deltaDays);
  if (fields.start) result.start = addDays(fields.start, deltaDays);
  return result;
}
