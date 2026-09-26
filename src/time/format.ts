import { DateTime, IANAZone } from 'luxon';

/** Wall time in a zone, 'YYYY-MM-DD HH:mm'. Never carries an offset. */
export type LocalDateTime = string;
/** A calendar date, 'YYYY-MM-DD'. */
export type LocalDate = string;

const LOCALE = 'en-US';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a real calendar date (rejects 2026-02-30, wrong digit counts, etc). */
export function isValidLocalDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  return DateTime.fromFormat(s, 'yyyy-MM-dd', { zone: 'utc' }).isValid;
}

/** True for 'YYYY-MM-DD HH:mm' with a real calendar date, HH 00-23, mm 00-59. */
export function isValidLocalDateTime(s: string): boolean {
  if (!DATETIME_RE.test(s)) return false;
  return isValidLocalDate(s.slice(0, 10));
}

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

/**
 * Wall time in `zone` to the instant it denotes.
 * A gap (spring-forward) resolves to the first valid instant after the gap.
 * An overlap (fall-back) resolves to the earlier of the two instants.
 * (Both are luxon's default behaviour for a non-existent/ambiguous local time.)
 */
export function localToInstant(local: LocalDateTime, zone: string): Date {
  const dt = DateTime.fromFormat(local, 'yyyy-MM-dd HH:mm', { zone });
  if (!dt.isValid) {
    throw new Error(
      `Invalid local date-time "${local}" for zone "${zone}": ${dt.invalidReason ?? ''}`,
    );
  }
  return dt.toJSDate();
}

export function instantToLocal(d: Date, zone: string): LocalDateTime {
  return DateTime.fromJSDate(d, { zone }).toFormat('yyyy-MM-dd HH:mm');
}

export function localDate(d: Date, zone: string): LocalDate {
  return DateTime.fromJSDate(d, { zone }).toFormat('yyyy-MM-dd');
}

/** Calendar-day arithmetic on a floating date (no zone, no DST). */
export function addDays(date: LocalDate, days: number): LocalDate {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toFormat('yyyy-MM-dd');
}

function diffDaysUtc(from: LocalDate, to: LocalDate): number {
  const a = DateTime.fromISO(from, { zone: 'utc' });
  const b = DateTime.fromISO(to, { zone: 'utc' });
  return Math.round(b.diff(a, 'days').days);
}

/** 'Tue', locale-independent (always English). */
export function weekdayShort(date: LocalDate): string {
  return DateTime.fromISO(date, { zone: 'utc', locale: LOCALE }).toFormat('ccc');
}

/** 'Saturday, September 26' */
export function formatLongDate(date: LocalDate): string {
  return DateTime.fromISO(date, { zone: 'utc', locale: LOCALE }).toFormat('cccc, LLLL d');
}

/** '2026-09-26 11:20 Sat' */
export function formatNow(d: Date, zone: string): string {
  const local = instantToLocal(d, zone);
  const date = localDate(d, zone);
  return `${local} ${weekdayShort(date)}`;
}

/** '09:00' -> '9:00am', '15:30' -> '3:30pm', '00:00' -> '12:00am', '12:00' -> '12:00pm' */
export function formatClock(hhmm: string): string {
  const [hStr = '0', mStr = '0'] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  const period = h < 12 ? 'am' : 'pm';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')}${period}`;
}

/**
 * today -> 'today 3:00pm'; tomorrow..+6 days -> 'Tue 9:00am'; else 'Mon Oct 12, 9:00am'
 * (year inserted before the time, ', 2027', when the date isn't in the current year).
 */
export function formatReceiptTime(local: LocalDateTime, opts: { now: Date; zone: string }): string {
  const { now, zone } = opts;
  const datePart = local.slice(0, 10);
  const timePart = local.slice(11);
  const today = localDate(now, zone);
  const diff = diffDaysUtc(today, datePart);
  const clock = formatClock(timePart);

  if (diff === 0) return `today ${clock}`;
  if (diff >= 1 && diff <= 6) return `${weekdayShort(datePart)} ${clock}`;

  const nowYear = DateTime.fromJSDate(now, { zone }).year;
  const dt = DateTime.fromISO(datePart, { zone: 'utc', locale: LOCALE });
  let base = dt.toFormat('ccc LLL d');
  if (dt.year !== nowYear) base += `, ${dt.year}`;
  return `${base}, ${clock}`;
}

/**
 * 'Reminder set: Tue 9:00am.' / 'Reminders set: Tue 9:00am; Sun 7:00pm.' / null for [].
 */
export function formatReceipt(
  locals: LocalDateTime[],
  opts: { now: Date; zone: string },
): string | null {
  if (locals.length === 0) return null;
  const parts = locals.map((local) => formatReceiptTime(local, opts));
  const label = locals.length === 1 ? 'Reminder set' : 'Reminders set';
  return `${label}: ${parts.join('; ')}.`;
}
