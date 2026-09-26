import { describe, expect, it } from 'vitest';
import {
  parseClock,
  parseDateExpression,
  parseTimeExpression,
  TIME_EXPRESSION_HELP,
} from '../../../src/time/expressions.ts';

const LA = 'America/Los_Angeles';

// 2026-09-26 11:20 America/Los_Angeles (Saturday, PDT)
const NOW_SAT_MORNING = new Date('2026-09-26T18:20:00Z');
// 2026-09-26 23:59 America/Los_Angeles (Saturday, PDT)
const NOW_SAT_LATE = new Date('2026-09-27T06:59:00Z');
// 2026-09-26 00:00 America/Los_Angeles (Saturday, PDT)
const NOW_MIDNIGHT = new Date('2026-09-26T07:00:00Z');
// 2026-09-29 10:00 America/Los_Angeles (Tuesday, PDT)
const NOW_TUESDAY = new Date('2026-09-29T17:00:00Z');

function okLocal(expr: string, opts: { now: Date; zone: string }): string {
  const result = parseTimeExpression(expr, opts);
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value.local;
}

function okInstant(expr: string, opts: { now: Date; zone: string }): Date {
  const result = parseTimeExpression(expr, opts);
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value.instant;
}

describe('parseClock', () => {
  const accepted: Array<[string, string]> = [
    ['9am', '09:00'],
    ['9AM', '09:00'],
    ['9 am', '09:00'],
    ['9:30pm', '21:30'],
    ['9:30 PM', '21:30'],
    ['noon', '12:00'],
    ['NOON', '12:00'],
    ['midnight', '00:00'],
    ['15:00', '15:00'],
    ['9:00', '09:00'],
    ['09:00', '09:00'],
    ['0:00', '00:00'],
    ['12am', '00:00'],
    ['12pm', '12:00'],
    ['12:00am', '00:00'],
    ['12:00pm', '12:00'],
  ];

  it.each(accepted)('parseClock(%s) === %s', (input, expected) => {
    expect(parseClock(input)).toBe(expected);
  });

  const rejected = ['7', '25:00', '13pm', '0pm', '9:60am', '', 'nine', '24:00'];

  it.each(rejected)('parseClock(%s) === null', (input) => {
    expect(parseClock(input)).toBeNull();
  });
});

describe('parseTimeExpression: local literal forms', () => {
  it('parses YYYY-MM-DD HH:mm', () => {
    expect(okLocal('2026-09-29 09:00', { now: NOW_SAT_MORNING, zone: LA })).toBe(
      '2026-09-29 09:00',
    );
  });

  it('parses YYYY-MM-DDTHH:mm', () => {
    expect(okLocal('2026-09-29T09:00', { now: NOW_SAT_MORNING, zone: LA })).toBe(
      '2026-09-29 09:00',
    );
  });

  it('tolerates extra whitespace and is case-insensitive on T', () => {
    expect(okLocal('2026-09-29t09:00', { now: NOW_SAT_MORNING, zone: LA })).toBe(
      '2026-09-29 09:00',
    );
    expect(okLocal('  2026-09-29   09:00  ', { now: NOW_SAT_MORNING, zone: LA })).toBe(
      '2026-09-29 09:00',
    );
  });
});

describe('parseTimeExpression: DST spring-forward (2026-03-08)', () => {
  it('2026-03-08 02:30 resolves to the 03:30 PDT instant', () => {
    const instant = okInstant('2026-03-08 02:30', { now: NOW_SAT_MORNING, zone: LA });
    expect(instant.toISOString()).toBe('2026-03-08T10:30:00.000Z');
    expect(okLocal('2026-03-08 02:30', { now: NOW_SAT_MORNING, zone: LA })).toBe(
      '2026-03-08 03:30',
    );
  });

  it('"today 02:30" on the transition day resolves the same way', () => {
    const now = new Date('2026-03-08T09:00:00Z'); // 2026-03-08 01:00 PST
    expect(okLocal('today 02:30', { now, zone: LA })).toBe('2026-03-08 03:30');
  });

  it('+1d across the transition keeps the clock time (09:00 -> 09:00)', () => {
    const now = new Date('2026-03-07T17:00:00Z'); // 2026-03-07 09:00 PST
    expect(okLocal('+1d', { now, zone: LA })).toBe('2026-03-08 09:00');
  });

  it('+24h is an exact duration and shifts the clock time by an hour', () => {
    const now = new Date('2026-03-07T17:00:00Z'); // 2026-03-07 09:00 PST
    expect(okLocal('+24h', { now, zone: LA })).toBe('2026-03-08 10:00');
  });
});

describe('parseTimeExpression: DST fall-back (2026-11-01)', () => {
  it('2026-11-01 01:30 resolves to the earlier (PDT) instant', () => {
    const instant = okInstant('2026-11-01 01:30', { now: NOW_SAT_MORNING, zone: LA });
    expect(instant.toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });

  it('instantToLocal of both 01:30 instants reads back as 01:30', () => {
    const earlier = okInstant('2026-11-01 01:30', { now: NOW_SAT_MORNING, zone: LA });
    const later = new Date(earlier.getTime() + 60 * 60 * 1000);
    expect(okLocal('2026-11-01 01:30', { now: NOW_SAT_MORNING, zone: LA })).toBe(
      '2026-11-01 01:30',
    );
    // The later occurrence (PST) is a distinct instant, one hour after the earlier one.
    expect(later.getTime()).toBe(earlier.getTime() + 3_600_000);
  });
});

describe('parseTimeExpression: ISO 8601 with offsets', () => {
  it('parses Z', () => {
    expect(okLocal('2026-09-29T16:00:00Z', { now: NOW_SAT_MORNING, zone: LA })).toBe(
      '2026-09-29 09:00',
    );
  });

  it('parses lowercase z', () => {
    expect(okLocal('2026-09-29t16:00:00z', { now: NOW_SAT_MORNING, zone: LA })).toBe(
      '2026-09-29 09:00',
    );
  });

  it('parses an offset from another zone (+05:30, India)', () => {
    // 2026-09-29 16:00 IST == 2026-09-29 10:30 UTC == 2026-09-29 03:30 PDT
    expect(okLocal('2026-09-29T16:00:00+05:30', { now: NOW_SAT_MORNING, zone: LA })).toBe(
      '2026-09-29 03:30',
    );
  });

  it('parses an offset without seconds', () => {
    expect(okLocal('2026-09-29T16:00+00:00', { now: NOW_SAT_MORNING, zone: LA })).toBe(
      '2026-09-29 09:00',
    );
  });
});

describe('parseTimeExpression: today / tonight', () => {
  it('today <clock>', () => {
    expect(okLocal('today 15:00', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-09-26 15:00');
  });

  it('today with no clock is rejected', () => {
    expect(parseTimeExpression('today', { now: NOW_SAT_MORNING, zone: LA }).ok).toBe(false);
  });

  it('tonight defaults to 20:00', () => {
    expect(okLocal('tonight', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-09-26 20:00');
  });

  it('tonight <clock> overrides the default', () => {
    expect(okLocal('tonight 9pm', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-09-26 21:00');
  });

  it('resolves relative to "now" at 23:59', () => {
    expect(okLocal('today 23:00', { now: NOW_SAT_LATE, zone: LA })).toBe('2026-09-26 23:00');
  });

  it('resolves relative to "now" at midnight', () => {
    expect(okLocal('today 01:00', { now: NOW_MIDNIGHT, zone: LA })).toBe('2026-09-26 01:00');
  });
});

describe('parseTimeExpression: tomorrow', () => {
  it('tomorrow <clock>', () => {
    expect(okLocal('tomorrow 09:00', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-09-27 09:00');
  });

  it('tomorrow at 23:59 "now" still rolls to the next calendar day', () => {
    expect(okLocal('tomorrow 09:00', { now: NOW_SAT_LATE, zone: LA })).toBe('2026-09-27 09:00');
  });

  it('tomorrow with no clock is rejected', () => {
    expect(parseTimeExpression('tomorrow', { now: NOW_SAT_MORNING, zone: LA }).ok).toBe(false);
  });
});

describe('parseTimeExpression: weekday / next weekday', () => {
  it('a future weekday this week', () => {
    // now is Saturday 2026-09-26; next Tuesday is 2026-09-29.
    expect(okLocal('tuesday 09:00', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-09-29 09:00');
  });

  it('the same weekday as today resolves to next week, not today', () => {
    expect(okLocal('tuesday 09:00', { now: NOW_TUESDAY, zone: LA })).toBe('2026-10-06 09:00');
  });

  it('"next <weekday>" behaves the same as "<weekday>"', () => {
    expect(okLocal('next tuesday 09:00', { now: NOW_TUESDAY, zone: LA })).toBe('2026-10-06 09:00');
  });

  it('accepts 3-letter and full weekday names, case-insensitively', () => {
    expect(okLocal('Fri 09:00', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-10-02 09:00');
    expect(okLocal('FRIDAY 09:00', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-10-02 09:00');
  });

  it('wraps around a full week correctly from Saturday', () => {
    expect(okLocal('saturday 09:00', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-10-03 09:00');
  });
});

describe('parseTimeExpression: relative durations', () => {
  it('+Nm', () => {
    expect(okLocal('+30m', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-09-26 11:50');
  });

  it('+Nh', () => {
    expect(okLocal('+2h', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-09-26 13:20');
  });

  it('+Nd keeps the clock time', () => {
    expect(okLocal('+1d', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-09-27 11:20');
  });

  it('combines h and m', () => {
    expect(okLocal('+1h30m', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-09-26 12:50');
  });

  it('combines d and h', () => {
    expect(okLocal('+1d2h', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-09-27 13:20');
  });

  it('+Nd <clock> is N days from today at that clock', () => {
    expect(okLocal('+3d 09:00', { now: NOW_SAT_MORNING, zone: LA })).toBe('2026-09-29 09:00');
  });

  it('rolls over midnight from "now" at 23:59', () => {
    expect(okLocal('+30m', { now: NOW_SAT_LATE, zone: LA })).toBe('2026-09-27 00:29');
  });
});

describe('parseTimeExpression: rejects', () => {
  const rejected = [
    '',
    '   ',
    '2026-02-30 09:00',
    '2026-09-26 25:00',
    '7',
    'sometime next week',
    'yesterday',
    'today 7', // clock without am/pm or colon
    'tomorrow',
    'today',
  ];

  it.each(rejected)('rejects %j', (expr) => {
    const result = parseTimeExpression(expr, { now: NOW_SAT_MORNING, zone: LA });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('\n');
      expect(result.error.endsWith(TIME_EXPRESSION_HELP)).toBe(true);
    }
  });
});

describe('parseDateExpression', () => {
  it('parses an explicit date', () => {
    const result = parseDateExpression('2026-10-12', { now: NOW_SAT_MORNING, zone: LA });
    expect(result).toEqual({ ok: true, value: '2026-10-12' });
  });

  it('parses today / tomorrow', () => {
    expect(parseDateExpression('today', { now: NOW_SAT_MORNING, zone: LA })).toEqual({
      ok: true,
      value: '2026-09-26',
    });
    expect(parseDateExpression('tomorrow', { now: NOW_SAT_MORNING, zone: LA })).toEqual({
      ok: true,
      value: '2026-09-27',
    });
  });

  it('parses a weekday and "next" weekday', () => {
    expect(parseDateExpression('friday', { now: NOW_SAT_MORNING, zone: LA })).toEqual({
      ok: true,
      value: '2026-10-02',
    });
    expect(parseDateExpression('next friday', { now: NOW_SAT_MORNING, zone: LA })).toEqual({
      ok: true,
      value: '2026-10-02',
    });
    // Tuesday, asked on a Tuesday, means next week.
    expect(parseDateExpression('tuesday', { now: NOW_TUESDAY, zone: LA })).toEqual({
      ok: true,
      value: '2026-10-06',
    });
  });

  it('parses +Nd', () => {
    expect(parseDateExpression('+3d', { now: NOW_SAT_MORNING, zone: LA })).toEqual({
      ok: true,
      value: '2026-09-29',
    });
  });

  it('rejects an invalid calendar date and empty input', () => {
    expect(parseDateExpression('2026-02-30', { now: NOW_SAT_MORNING, zone: LA }).ok).toBe(false);
    expect(parseDateExpression('', { now: NOW_SAT_MORNING, zone: LA }).ok).toBe(false);
    expect(parseDateExpression('9am', { now: NOW_SAT_MORNING, zone: LA }).ok).toBe(false);
  });
});
