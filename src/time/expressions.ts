import { DateTime } from 'luxon';
import {
  addDays,
  instantToLocal,
  isValidLocalDate,
  isValidLocalDateTime,
  localDate,
  localToInstant,
  type LocalDate,
  type LocalDateTime,
} from './format.ts';

export type ExprResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const TIME_EXPRESSION_HELP =
  'Accepted forms: "2026-09-29 09:00" (or with a T), an ISO 8601 timestamp with an offset or Z, ' +
  '"today 3pm", "tonight" (defaults to 8pm), "tomorrow 9am", "tuesday 9am" / "next friday 6pm" ' +
  '(the next such weekday), "+2h", "+1h30m", "+1d" (keeps the current time), "+3d 9am"; ' +
  'clock times may be "9am", "9:30pm", "noon", "midnight", or 24-hour "HH:mm".';

const WEEKDAY_MAP: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7,
};

function timeErr(expr: string): ExprResult<never> {
  return {
    ok: false,
    error: `Could not understand "${expr.trim()}" as a time. ${TIME_EXPRESSION_HELP}`,
  };
}

function dateErr(expr: string): ExprResult<never> {
  return {
    ok: false,
    error: `Could not understand "${expr.trim()}" as a date. ${TIME_EXPRESSION_HELP}`,
  };
}

/**
 * 'H:mm'/'HH:mm' (24-hour), 'h[:mm]am'/'pm' (case-insensitive, optional space), 'noon', 'midnight'.
 * A bare number like '7' (no colon, no am/pm) is rejected. Returns 24-hour 'HH:mm' or null.
 */
export function parseClock(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (t === 'noon') return '12:00';
  if (t === 'midnight') return '00:00';

  const ampm = /^([0-9]{1,2})(?::([0-5][0-9]))?\s*(am|pm)$/.exec(t);
  if (ampm) {
    const rawHour = Number(ampm[1]);
    const minute = ampm[2] !== undefined ? Number(ampm[2]) : 0;
    const period = ampm[3];
    if (rawHour < 1 || rawHour > 12) return null;
    let hour = rawHour === 12 ? 0 : rawHour;
    if (period === 'pm') hour += 12;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  const hm = /^([0-9]{1,2}):([0-5][0-9])$/.exec(t);
  if (hm) {
    const hour = Number(hm[1]);
    const minute = Number(hm[2]);
    if (hour > 23) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  return null;
}

function nextWeekdayOnOrAfter(today: LocalDate, targetIso: number): LocalDate {
  const dt = DateTime.fromISO(today, { zone: 'utc' });
  let diff = targetIso - dt.weekday;
  if (diff <= 0) diff += 7;
  return dt.plus({ days: diff }).toFormat('yyyy-MM-dd');
}

function weekdayNumber(name: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(WEEKDAY_MAP, name) ? WEEKDAY_MAP[name] : undefined;
}

function toResult(local: LocalDateTime, zone: string): { local: LocalDateTime; instant: Date } {
  // Recompute `local` from the resolved instant: a spring-forward gap (e.g.
  // 02:30 on a transition day) doesn't denote a real wall-clock moment, so
  // vault-format.md normalizes it to the instant it actually resolves to
  // (03:30). An ambiguous fall-back time is unaffected (same string, earlier
  // instant).
  const instant = localToInstant(local, zone);
  return { local: instantToLocal(instant, zone), instant };
}

export function parseTimeExpression(
  expr: string,
  opts: { now: Date; zone: string },
): ExprResult<{ local: LocalDateTime; instant: Date }> {
  const { now, zone } = opts;
  const raw = expr.trim();
  if (raw.length === 0) return timeErr(expr);

  const collapsed = raw.replace(/\s+/g, ' ');
  const lower = collapsed.toLowerCase();

  // 'YYYY-MM-DD HH:mm' or 'YYYY-MM-DDTHH:mm' (local wall time, no offset)
  const localLiteral = /^(\d{4}-\d{2}-\d{2})[t ](\d{2}:\d{2})$/i.exec(collapsed);
  if (localLiteral) {
    const local = `${localLiteral[1]} ${localLiteral[2]}`;
    if (!isValidLocalDateTime(local)) return timeErr(expr);
    return { ok: true, value: toResult(local, zone) };
  }

  // ISO 8601 with an explicit offset or Z
  const noSpace = collapsed.replace(/\s+/g, '');
  const isoOffset = /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:\d{2})$/i.exec(
    noSpace,
  );
  if (isoOffset) {
    const dt = DateTime.fromISO(noSpace, { setZone: true });
    if (!dt.isValid) return timeErr(expr);
    const instant = dt.toJSDate();
    return { ok: true, value: { local: instantToLocal(instant, zone), instant } };
  }

  // 'today <clock>' / 'tonight [<clock>]' (tonight defaults to 20:00)
  const todayMatch = /^(today|tonight)(?:\s+(.+))?$/i.exec(lower);
  if (todayMatch) {
    const keyword = todayMatch[1];
    const clockStr = todayMatch[2];
    const clock =
      clockStr !== undefined ? parseClock(clockStr) : keyword === 'tonight' ? '20:00' : null;
    if (!clock) return timeErr(expr);
    const local = `${localDate(now, zone)} ${clock}`;
    return { ok: true, value: toResult(local, zone) };
  }

  // 'tomorrow <clock>'
  const tomorrowMatch = /^tomorrow(?:\s+(.+))?$/i.exec(lower);
  if (tomorrowMatch) {
    const clock = tomorrowMatch[1] !== undefined ? parseClock(tomorrowMatch[1]) : null;
    if (!clock) return timeErr(expr);
    const date = addDays(localDate(now, zone), 1);
    return { ok: true, value: toResult(`${date} ${clock}`, zone) };
  }

  // '<weekday> <clock>' / 'next <weekday> <clock>'
  const weekdayMatch = /^(?:next\s+)?([a-z]+)\s+(.+)$/i.exec(lower);
  if (weekdayMatch) {
    const iso = weekdayNumber(weekdayMatch[1] ?? '');
    if (iso !== undefined) {
      const clock = parseClock(weekdayMatch[2] ?? '');
      if (!clock) return timeErr(expr);
      const date = nextWeekdayOnOrAfter(localDate(now, zone), iso);
      return { ok: true, value: toResult(`${date} ${clock}`, zone) };
    }
  }

  // '+Nd <clock>' -> N days from today at clock
  const dayClockMatch = /^\+(\d+)d\s+(.+)$/i.exec(lower);
  if (dayClockMatch) {
    const clock = parseClock(dayClockMatch[2] ?? '');
    if (!clock) return timeErr(expr);
    const date = addDays(localDate(now, zone), Number(dayClockMatch[1]));
    return { ok: true, value: toResult(`${date} ${clock}`, zone) };
  }

  // '+Nm', '+Nh', '+Nd', combinations '+1h30m', '+1d2h' (relative to now)
  const relMatch = /^\+(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/i.exec(lower);
  if (
    relMatch &&
    (relMatch[1] !== undefined || relMatch[2] !== undefined || relMatch[3] !== undefined)
  ) {
    const days = relMatch[1] !== undefined ? Number(relMatch[1]) : 0;
    const hours = relMatch[2] !== undefined ? Number(relMatch[2]) : 0;
    const minutes = relMatch[3] !== undefined ? Number(relMatch[3]) : 0;
    // luxon adds calendar days (DST-safe, keeps wall time) and exact hours/minutes in one call.
    const result = DateTime.fromJSDate(now, { zone }).plus({ days, hours, minutes });
    const instant = result.toJSDate();
    return { ok: true, value: { local: instantToLocal(instant, zone), instant } };
  }

  return timeErr(expr);
}

export function parseDateExpression(
  expr: string,
  opts: { now: Date; zone: string },
): ExprResult<LocalDate> {
  const { now, zone } = opts;
  const raw = expr.trim();
  if (raw.length === 0) return dateErr(expr);

  if (isValidLocalDate(raw)) return { ok: true, value: raw };

  const lower = raw.replace(/\s+/g, ' ').toLowerCase();

  if (lower === 'today') return { ok: true, value: localDate(now, zone) };
  if (lower === 'tomorrow') return { ok: true, value: addDays(localDate(now, zone), 1) };

  const weekdayMatch = /^(?:next\s+)?([a-z]+)$/i.exec(lower);
  if (weekdayMatch) {
    const iso = weekdayNumber(weekdayMatch[1] ?? '');
    if (iso !== undefined) {
      return { ok: true, value: nextWeekdayOnOrAfter(localDate(now, zone), iso) };
    }
  }

  const relMatch = /^\+(\d+)d$/i.exec(lower);
  if (relMatch) {
    return { ok: true, value: addDays(localDate(now, zone), Number(relMatch[1])) };
  }

  return dateErr(expr);
}
