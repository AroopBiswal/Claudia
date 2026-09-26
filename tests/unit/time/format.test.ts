import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatClock,
  formatLongDate,
  formatNow,
  formatReceipt,
  formatReceiptTime,
  instantToLocal,
  isValidLocalDate,
  isValidLocalDateTime,
  isValidZone,
  localDate,
  localToInstant,
  weekdayShort,
} from '../../../src/time/format.ts';

const LA = 'America/Los_Angeles';
const LONDON = 'Europe/London';
const KOLKATA = 'Asia/Kolkata';

describe('localToInstant / instantToLocal', () => {
  it('round-trips an ordinary wall time', () => {
    const instant = localToInstant('2026-09-26 09:00', LA);
    expect(instant.toISOString()).toBe('2026-09-26T16:00:00.000Z');
    expect(instantToLocal(instant, LA)).toBe('2026-09-26 09:00');
  });

  it('resolves a spring-forward gap to the first valid instant after it (2026-03-08)', () => {
    // 2026-03-08 02:00 -> 03:00 in America/Los_Angeles; 02:30 does not exist.
    const instant = localToInstant('2026-03-08 02:30', LA);
    expect(instant.toISOString()).toBe('2026-03-08T10:30:00.000Z'); // 03:30 PDT
    expect(instantToLocal(instant, LA)).toBe('2026-03-08 03:30');
  });

  it('resolves a fall-back overlap to the earlier instant (2026-11-01)', () => {
    // 2026-11-01 01:30 occurs twice: once at PDT (-07:00), once at PST (-08:00).
    const instant = localToInstant('2026-11-01 01:30', LA);
    expect(instant.toISOString()).toBe('2026-11-01T08:30:00.000Z'); // -07:00, the earlier one
    expect(instantToLocal(instant, LA)).toBe('2026-11-01 01:30');

    const later = new Date(instant.getTime() + 60 * 60 * 1000);
    expect(instantToLocal(later, LA)).toBe('2026-11-01 01:30'); // still 01:30, now PST
  });

  it('honors a zone with no DST (Asia/Kolkata)', () => {
    const instant = localToInstant('2026-06-15 09:00', KOLKATA);
    expect(instant.toISOString()).toBe('2026-06-15T03:30:00.000Z'); // UTC+5:30, no half-hour DST wobble
    expect(instantToLocal(instant, KOLKATA)).toBe('2026-06-15 09:00');
  });

  it('honors a European DST zone (Europe/London)', () => {
    // BST -> GMT fall-back on 2026-10-25 at 02:00 local (01:00 UTC).
    const beforeFallback = localToInstant('2026-10-25 00:30', LONDON);
    expect(instantToLocal(beforeFallback, LONDON)).toBe('2026-10-25 00:30');
    const summer = localToInstant('2026-07-15 12:00', LONDON);
    expect(summer.toISOString()).toBe('2026-07-15T11:00:00.000Z'); // BST = UTC+1
  });
});

describe('localDate / addDays', () => {
  it('extracts the local calendar date from an instant', () => {
    // 2026-09-26 06:00 UTC is 2026-09-25 23:00 PDT (previous day).
    expect(localDate(new Date('2026-09-26T06:00:00Z'), LA)).toBe('2026-09-25');
  });

  it('adds days as calendar arithmetic, independent of DST', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-09-26', -3)).toBe('2026-09-23');
  });
});

describe('weekdayShort / formatLongDate', () => {
  it('formats a short weekday name', () => {
    expect(weekdayShort('2026-09-26')).toBe('Sat');
    expect(weekdayShort('2026-09-29')).toBe('Tue');
  });

  it('formats a long date', () => {
    expect(formatLongDate('2026-09-26')).toBe('Saturday, September 26');
  });
});

describe('formatNow', () => {
  it('formats now as YYYY-MM-DD HH:mm Ddd', () => {
    expect(formatNow(new Date('2026-09-26T18:20:00Z'), LA)).toBe('2026-09-26 11:20 Sat');
  });
});

describe('formatClock', () => {
  const cases: Array<[string, string]> = [
    ['09:00', '9:00am'],
    ['15:30', '3:30pm'],
    ['00:00', '12:00am'],
    ['12:00', '12:00pm'],
    ['00:05', '12:05am'],
    ['23:59', '11:59pm'],
    ['01:00', '1:00am'],
    ['13:00', '1:00pm'],
  ];

  it.each(cases)('formatClock(%s) === %s', (input, expected) => {
    expect(formatClock(input)).toBe(expected);
  });
});

describe('formatReceiptTime / formatReceipt boundaries', () => {
  const now = new Date('2026-09-26T18:20:00Z'); // 2026-09-26 11:20 PDT, Saturday

  it('formats today', () => {
    expect(formatReceiptTime('2026-09-26 15:00', { now, zone: LA })).toBe('today 3:00pm');
  });

  it('formats tomorrow (within the 6-day window) as a weekday', () => {
    expect(formatReceiptTime('2026-09-27 09:00', { now, zone: LA })).toBe('Sun 9:00am');
  });

  it('formats +6 days as a weekday (last day of the near window)', () => {
    expect(formatReceiptTime('2026-10-02 09:00', { now, zone: LA })).toBe('Fri 9:00am');
  });

  it('formats +7 days with the full date form', () => {
    expect(formatReceiptTime('2026-10-03 09:00', { now, zone: LA })).toBe('Sat Oct 3, 9:00am');
  });

  it('adds the year when the date is not in the current year', () => {
    expect(formatReceiptTime('2027-01-05 09:00', { now, zone: LA })).toBe(
      'Tue Jan 5, 2027, 9:00am',
    );
  });

  it('returns null for an empty list', () => {
    expect(formatReceipt([], { now, zone: LA })).toBeNull();
  });

  it('formats a single reminder', () => {
    expect(formatReceipt(['2026-09-27 09:00'], { now, zone: LA })).toBe(
      'Reminder set: Sun 9:00am.',
    );
  });

  it('formats several reminders, semicolon-joined', () => {
    expect(formatReceipt(['2026-09-27 09:00', '2026-10-04 19:00'], { now, zone: LA })).toBe(
      'Reminders set: Sun 9:00am; Sun Oct 4, 7:00pm.',
    );
  });
});

describe('isValidZone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidZone(LA)).toBe(true);
    expect(isValidZone(LONDON)).toBe(true);
    expect(isValidZone(KOLKATA)).toBe(true);
    expect(isValidZone('UTC')).toBe(true);
  });

  it('rejects a bogus zone', () => {
    expect(isValidZone('Not/AZone')).toBe(false);
    expect(isValidZone('')).toBe(false);
  });
});

describe('isValidLocalDate / isValidLocalDateTime', () => {
  it('accepts real calendar dates', () => {
    expect(isValidLocalDate('2026-09-26')).toBe(true);
    expect(isValidLocalDate('2024-02-29')).toBe(true); // leap year
  });

  it('rejects dates that do not exist', () => {
    expect(isValidLocalDate('2026-02-30')).toBe(false);
    expect(isValidLocalDate('2026-02-29')).toBe(false); // not a leap year
    expect(isValidLocalDate('2026-13-01')).toBe(false);
    expect(isValidLocalDate('2026-9-26')).toBe(false); // must be zero-padded
    expect(isValidLocalDate('not-a-date')).toBe(false);
  });

  it('accepts valid local date-times', () => {
    expect(isValidLocalDateTime('2026-09-26 09:00')).toBe(true);
    expect(isValidLocalDateTime('2026-09-26 23:59')).toBe(true);
    expect(isValidLocalDateTime('2026-09-26 00:00')).toBe(true);
  });

  it('rejects out-of-range or malformed times', () => {
    expect(isValidLocalDateTime('2026-09-26 24:00')).toBe(false);
    expect(isValidLocalDateTime('2026-09-26 25:00')).toBe(false);
    expect(isValidLocalDateTime('2026-09-26 09:60')).toBe(false);
    expect(isValidLocalDateTime('2026-02-30 09:00')).toBe(false);
    expect(isValidLocalDateTime('2026-09-26T09:00')).toBe(false); // T not accepted here
    expect(isValidLocalDateTime('2026-09-26 9:00')).toBe(false); // must be zero-padded
  });
});
