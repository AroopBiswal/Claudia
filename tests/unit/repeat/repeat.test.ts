import { describe, expect, it } from 'vitest';
import {
  nextAnchor,
  nextRepeatFields,
  parseRepeat,
  type RepeatRule,
} from '../../../src/vault/repeat.ts';

describe('parseRepeat', () => {
  const validCases: Array<[string, boolean]> = [
    ['every day', false],
    ['every 2 days', false],
    ['every week', false],
    ['every week on Sunday', false],
    ['every week on Monday, Thursday', false],
    ['every weekday', false],
    ['every month', false],
    ['every month on the 15th', false],
    ['every year', false],
    ['every day when done', true],
    ['every week on Sunday when done', true],
  ];

  it.each(validCases)('parseRepeat(%j) is valid, whenDone=%s', (text, whenDone) => {
    const rule = parseRepeat(text);
    expect(rule.valid).toBe(true);
    expect(rule.whenDone).toBe(whenDone);
    expect(rule.text).toBe(text);
  });

  const invalidCases = [
    'every blue moon',
    '',
    'when done',
    'every hour',
    'every 3 months',
    'every 2 years',
    'every month on the 1st friday',
  ];

  it.each(invalidCases)('parseRepeat(%j) is invalid', (text) => {
    const rule = parseRepeat(text);
    expect(rule.valid).toBe(false);
    expect(rule.text).toBe(text);
  });
});

describe('nextAnchor', () => {
  it('daily', () => {
    const rule = parseRepeat('every day');
    expect(nextAnchor(rule, '2026-09-26', '2026-09-26')).toBe('2026-09-27');
  });

  it('every 2 days', () => {
    const rule = parseRepeat('every 2 days');
    expect(nextAnchor(rule, '2026-09-26', '2026-09-26')).toBe('2026-09-28');
  });

  it("weekly (defaults to the anchor's weekday)", () => {
    const rule = parseRepeat('every week');
    // 2026-09-26 is a Saturday.
    expect(nextAnchor(rule, '2026-09-26', '2026-09-26')).toBe('2026-10-03');
  });

  it('every week on Sunday, anchored on a Sunday, goes to the following Sunday', () => {
    const rule = parseRepeat('every week on Sunday');
    expect(nextAnchor(rule, '2026-09-27', '2026-09-27')).toBe('2026-10-04');
  });

  it('every week on Monday, Thursday picks the nearer of the two', () => {
    const rule = parseRepeat('every week on Monday, Thursday');
    // Anchored on Friday 2026-09-25: next Monday is 2026-09-28.
    expect(nextAnchor(rule, '2026-09-25', '2026-09-25')).toBe('2026-09-28');
    // Anchored on Monday 2026-09-28: next is Thursday 2026-10-01.
    expect(nextAnchor(rule, '2026-09-28', '2026-09-28')).toBe('2026-10-01');
  });

  it('every weekday skips the weekend (Fri -> Mon)', () => {
    const rule = parseRepeat('every weekday');
    // 2026-10-02 is a Friday.
    expect(nextAnchor(rule, '2026-10-02', '2026-10-02')).toBe('2026-10-05');
  });

  it('monthly on the 15th', () => {
    const rule = parseRepeat('every month on the 15th');
    expect(nextAnchor(rule, '2026-09-15', '2026-09-15')).toBe('2026-10-15');
  });

  it('every month, anchored on the 31st, skips months without a 31st (rrule quirk)', () => {
    const rule = parseRepeat('every month');
    // rrule's monthly frequency defaults BYMONTHDAY from dtstart and simply
    // produces no occurrence in a month that lacks that day, rather than
    // clamping to the month's last day. From 2026-01-31 the next occurrence
    // is 2026-03-31 (February is skipped entirely).
    expect(nextAnchor(rule, '2026-01-31', '2026-01-31')).toBe('2026-03-31');
  });

  it('yearly, anchored on Feb 29, goes to the next leap year', () => {
    const rule = parseRepeat('every year');
    expect(nextAnchor(rule, '2024-02-29', '2024-02-29')).toBe('2028-02-29');
  });

  it('"when done" searches after today rather than after the anchor', () => {
    const rule = parseRepeat('every week on Sunday when done');
    // Anchor (due date) is 2026-09-20 (a Sunday), but the task was completed
    // (today) on 2026-09-26 (a Saturday); the next Sunday after today is
    // 2026-09-27, not the Sunday immediately after the anchor (2026-09-27
    // happens to coincide here, so also check a case where they'd differ).
    expect(nextAnchor(rule, '2026-09-20', '2026-09-26')).toBe('2026-09-27');
  });

  it('"when done" with an anchor before today still searches after today, not after the anchor', () => {
    const rule = parseRepeat('every day when done');
    // Without whenDone this would be 2026-09-21 (the day after the anchor);
    // whenDone means the search starts after today instead.
    expect(nextAnchor(rule, '2026-09-20', '2026-09-26')).toBe('2026-09-27');
  });

  it('an anchor far in the past returns the first occurrence not before today', () => {
    const rule = parseRepeat('every day');
    expect(nextAnchor(rule, '2020-01-01', '2026-09-26')).toBe('2026-09-26');
  });

  it('an anchor equal to today (weekly) still requires the next occurrence, not today', () => {
    const rule = parseRepeat('every week');
    expect(nextAnchor(rule, '2026-09-26', '2026-09-26')).toBe('2026-10-03');
  });

  it('returns null for an invalid rule', () => {
    const rule = parseRepeat('every blue moon');
    expect(nextAnchor(rule, '2026-09-26', '2026-09-26')).toBeNull();
  });
});

describe('nextRepeatFields', () => {
  it('shifts due and reminder by the same delta, keeping the reminder time', () => {
    const rule = parseRepeat('every day');
    const result = nextRepeatFields(
      { reminder: '2026-09-26 09:00', due: '2026-09-26' },
      rule,
      '2026-09-26',
    );
    expect(result).toEqual({ reminder: '2026-09-27 09:00', due: '2026-09-27' });
  });

  it('shifts reminder across a DST boundary, keeping its clock time', () => {
    // Anchor (from the reminder) is 2026-03-07; the daily repeat's next
    // occurrence is 2026-03-08, the spring-forward day. The reminder's time
    // of day must be preserved verbatim, not renormalized.
    const rule = parseRepeat('every day');
    const result = nextRepeatFields({ reminder: '2026-03-07 09:00' }, rule, '2026-03-07');
    expect(result).toEqual({ reminder: '2026-03-08 09:00' });
  });

  it('shifts scheduled and start fields by the same delta as due', () => {
    const rule = parseRepeat('every week on Sunday');
    const result = nextRepeatFields(
      { due: '2026-09-27', scheduled: '2026-09-25', start: '2026-09-20' },
      rule,
      '2026-09-27',
    );
    // next anchor after 2026-09-27 (a Sunday) is 2026-10-04: delta = 7 days.
    expect(result).toEqual({ due: '2026-10-04', scheduled: '2026-10-02', start: '2026-09-27' });
  });

  it('uses due as the anchor over reminder when both are present', () => {
    const rule = parseRepeat('every day');
    const result = nextRepeatFields(
      { reminder: '2026-09-20 09:00', due: '2026-09-26' },
      rule,
      '2026-09-26',
    );
    // anchor is due (2026-09-26) -> next is 2026-09-27, delta = 1 day, applied
    // to the reminder's date too even though the reminder's own date differs.
    expect(result).toEqual({ reminder: '2026-09-21 09:00', due: '2026-09-27' });
  });

  it('falls back to the reminder date when there is no due date', () => {
    const rule = parseRepeat('every day');
    const result = nextRepeatFields({ reminder: '2026-09-26 09:00' }, rule, '2026-09-26');
    expect(result).toEqual({ reminder: '2026-09-27 09:00' });
  });

  it('returns null when neither due nor reminder is present', () => {
    const rule = parseRepeat('every day');
    expect(nextRepeatFields({ scheduled: '2026-09-26' }, rule, '2026-09-26')).toBeNull();
  });

  it('returns null for an invalid rule', () => {
    const rule = parseRepeat('every blue moon');
    const result = nextRepeatFields({ reminder: '2026-09-26 09:00' }, rule, '2026-09-26');
    expect(result).toBeNull();
  });

  it('when done: anchor stays due/reminder, but the search starts after today', () => {
    const rule: RepeatRule = parseRepeat('every week on Sunday when done');
    const result = nextRepeatFields({ due: '2026-09-20' }, rule, '2026-09-26');
    expect(result).toEqual({ due: '2026-09-27' });
  });
});
