import { describe, expect, it } from 'vitest';
import { parseTimeExpression } from '../../../src/time/expressions.ts';
import { formatReceipt, formatReceiptTime } from '../../../src/time/format.ts';

const LA = 'America/Los_Angeles';

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

describe('parseTimeExpression: "tuesday 09:00" evaluated right at a day boundary', () => {
  it('at Tuesday 23:59:59, "today" is still Tuesday, so it resolves to next Tuesday (not today)', () => {
    // 2026-09-29 23:59:59 America/Los_Angeles (Tuesday, PDT) == 2026-09-30T06:59:59Z
    const now = new Date('2026-09-30T06:59:59Z');
    expect(okLocal('tuesday 09:00', { now, zone: LA })).toBe('2026-10-06 09:00');
  });

  it('one second later, at Wednesday 00:00:00, resolves to the same absolute next-Tuesday date', () => {
    // 2026-09-30 00:00:00 America/Los_Angeles (Wednesday, PDT) == 2026-09-30T07:00:00Z
    const now = new Date('2026-09-30T07:00:00Z');
    expect(okLocal('tuesday 09:00', { now, zone: LA })).toBe('2026-10-06 09:00');
  });
});

describe('parseTimeExpression: "+1d" from 01:30 on the fall-back day (2026-11-01)', () => {
  it('advances exactly one calendar day, keeping the 01:30 wall time, spanning the 25-hour day', () => {
    // The earlier (PDT) occurrence of 2026-11-01 01:30.
    const earlier = okInstant('2026-11-01 01:30', {
      now: new Date('2026-09-26T18:20:00Z'),
      zone: LA,
    });
    expect(earlier.toISOString()).toBe('2026-11-01T08:30:00.000Z');

    const local = okLocal('+1d', { now: earlier, zone: LA });
    expect(local).toBe('2026-11-02 01:30');

    // 2026-11-01 is a 25-hour day in America/Los_Angeles (fall-back), so the instant delta for
    // "+1 calendar day, same wall clock" must be 25 hours, not 24.
    const resultInstant = okInstant('+1d', { now: earlier, zone: LA });
    expect(resultInstant.getTime() - earlier.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it('also works from the later (PST) occurrence of the same wall time', () => {
    const earlier = okInstant('2026-11-01 01:30', {
      now: new Date('2026-09-26T18:20:00Z'),
      zone: LA,
    });
    const later = new Date(earlier.getTime() + 60 * 60 * 1000); // same wall clock, PST
    const local = okLocal('+1d', { now: later, zone: LA });
    expect(local).toBe('2026-11-02 01:30');
  });
});

describe('parseTimeExpression: "today 25:00" is rejected', () => {
  it('rejects because 25:00 is not a valid clock time', () => {
    const result = parseTimeExpression('today 25:00', {
      now: new Date('2026-09-26T18:20:00Z'),
      zone: LA,
    });
    expect(result.ok).toBe(false);
  });
});

describe('parseTimeExpression: "2026-13-01 09:00" (invalid month) is rejected', () => {
  it('rejects an out-of-range month in the local literal form', () => {
    const result = parseTimeExpression('2026-13-01 09:00', {
      now: new Date('2026-09-26T18:20:00Z'),
      zone: LA,
    });
    expect(result.ok).toBe(false);
  });
});

describe('parseTimeExpression: mixed case and extra internal spaces', () => {
  const now = new Date('2026-09-26T18:20:00Z'); // Saturday

  it('accepts mixed-case weekday names with extra internal spaces', () => {
    expect(okLocal('  TuEsDaY    9Am  ', { now, zone: LA })).toBe('2026-09-29 09:00');
  });

  it('accepts mixed-case "Next Friday" with extra spaces', () => {
    expect(okLocal('Next   FRIDAY   6:00pm', { now, zone: LA })).toBe('2026-10-02 18:00');
  });

  it('accepts mixed-case "TOMORROW" with extra spaces before the clock', () => {
    expect(okLocal('TOMORROW     09:00', { now, zone: LA })).toBe('2026-09-27 09:00');
  });

  it('accepts mixed-case "Today Noon"', () => {
    expect(okLocal('Today Noon', { now, zone: LA })).toBe('2026-09-26 12:00');
  });
});

describe('parseTimeExpression: noon / midnight via full expressions', () => {
  const now = new Date('2026-09-26T18:20:00Z');

  it('"today noon"', () => {
    expect(okLocal('today noon', { now, zone: LA })).toBe('2026-09-26 12:00');
  });

  it('"tomorrow midnight"', () => {
    expect(okLocal('tomorrow midnight', { now, zone: LA })).toBe('2026-09-27 00:00');
  });

  it('"tuesday midnight"', () => {
    expect(okLocal('tuesday midnight', { now, zone: LA })).toBe('2026-09-29 00:00');
  });
});

describe('parseTimeExpression: ISO 8601 with +05:30 (India), full round trip', () => {
  it('converts to the correct local wall time', () => {
    const now = new Date('2026-09-26T18:20:00Z');
    // 2026-09-29 21:30 IST == 2026-09-29 16:00 UTC == 2026-09-29 09:00 PDT
    expect(okLocal('2026-09-29T21:30:00+05:30', { now, zone: LA })).toBe('2026-09-29 09:00');
  });
});

describe('formatReceiptTime: exactly 7 days out uses the long form, not the weekday form', () => {
  it('boundary at diff === 7', () => {
    const now = new Date('2026-09-26T18:20:00Z'); // 2026-09-26 11:20 PDT, Saturday
    expect(formatReceiptTime('2026-10-03 09:00', { now, zone: LA })).toBe('Sat Oct 3, 9:00am');
  });
});

describe('formatReceipt: current behaviour on duplicate reminder times', () => {
  it('does NOT de-duplicate: the same local time repeated appears twice in the receipt', () => {
    // Documenting current behaviour (not necessarily a bug): formatReceipt joins whatever list
    // it is given, with no de-duplication pass.
    const now = new Date('2026-09-26T18:20:00Z');
    const receipt = formatReceipt(['2026-09-27 09:00', '2026-09-27 09:00'], { now, zone: LA });
    expect(receipt).toBe('Reminders set: Sun 9:00am; Sun 9:00am.');
  });
});
