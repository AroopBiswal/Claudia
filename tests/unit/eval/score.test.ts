import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatReport, scoreAll, scoreCase, type ScoreOptions } from '../../eval/score.ts';
import type { CaseRun, Category, EvalCase, SavedItem } from '../../eval/types.ts';

// ---------------------------------------------------------------------------
// A tiny, self-contained time resolver for these tests. It understands only
// the handful of forms exercised below ('YYYY-MM-DD HH:mm' passthrough,
// 'tomorrow HH:mm', '<weekday> HH:mm', '+Nh'/'+Nm'/'+Nd') plus the matching
// date forms ('YYYY-MM-DD', 'today', 'tomorrow', '<weekday>'). It does NOT
// import any product code -- the real time/expressions.ts module doesn't
// exist yet (see docs/ROADMAP.md, M1-A2).
// ---------------------------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function atMidnightUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** Parses a validated 'HH:mm' string into [hours, minutes] without array-destructure undefined. */
function parseHHMM(hhmm: string): { hours: number; minutes: number } {
  return { hours: Number(hhmm.slice(0, 2)), minutes: Number(hhmm.slice(3, 5)) };
}

function nextWeekdayStrictlyAfter(now: Date, weekday: string): Date {
  const target = WEEKDAYS.indexOf(weekday.toLowerCase());
  const today = atMidnightUTC(now);
  const delta = (target - today.getUTCDay() + 7) % 7 || 7;
  return addDays(today, delta);
}

function fakeResolveTime(expr: string, now: Date): string {
  const abs = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(expr);
  if (abs) return `${abs[1]} ${abs[2]}`;

  const rel = /^\+(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(expr.trim());
  if (rel && (rel[1] ?? rel[2] ?? rel[3])) {
    const days = Number(rel[1] ?? 0);
    const hours = Number(rel[2] ?? 0);
    const minutes = Number(rel[3] ?? 0);
    const ms = ((days * 24 + hours) * 60 + minutes) * 60_000;
    return fmtDateTime(new Date(now.getTime() + ms));
  }

  const tomorrow = /^tomorrow (\d{2}:\d{2})$/.exec(expr);
  if (tomorrow) {
    const { hours, minutes } = parseHHMM(tomorrow[1]!);
    const d = addDays(atMidnightUTC(now), 1);
    d.setUTCHours(hours, minutes);
    return fmtDateTime(d);
  }

  const today = /^today (\d{2}:\d{2})$/.exec(expr);
  if (today) {
    const { hours, minutes } = parseHHMM(today[1]!);
    const d = atMidnightUTC(now);
    d.setUTCHours(hours, minutes);
    return fmtDateTime(d);
  }

  const weekday = /^(?:next )?(\w+) (\d{2}:\d{2})$/.exec(expr);
  if (weekday && WEEKDAYS.includes(weekday[1]!.toLowerCase())) {
    const { hours, minutes } = parseHHMM(weekday[2]!);
    const d = nextWeekdayStrictlyAfter(now, weekday[1]!);
    d.setUTCHours(hours, minutes);
    return fmtDateTime(d);
  }

  throw new Error(`fakeResolveTime: unrecognized expression "${expr}"`);
}

function fakeResolveDate(expr: string, now: Date): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(expr)) return expr;
  if (expr === 'today') return fmtDate(now);
  if (expr === 'tomorrow') return fmtDate(addDays(atMidnightUTC(now), 1));
  if (WEEKDAYS.includes(expr.toLowerCase())) {
    return fmtDate(nextWeekdayStrictlyAfter(now, expr));
  }
  throw new Error(`fakeResolveDate: unrecognized expression "${expr}"`);
}

const opts: ScoreOptions = {
  resolveTime: fakeResolveTime,
  resolveDate: fakeResolveDate,
  zone: 'America/Los_Angeles',
};

// A Wednesday, arbitrarily.
const NOW = new Date('2026-09-30T16:00:00.000Z');

function saved(overrides: Partial<SavedItem>): SavedItem {
  return {
    kind: 'task',
    text: '',
    person: null,
    people: [],
    direction: null,
    reminderLocal: null,
    due: null,
    appointmentStart: null,
    repeat: null,
    path: 'Tasks/To do.md',
    ...overrides,
  };
}

function run(overrides: Partial<CaseRun>): CaseRun {
  return {
    caseId: 'c1',
    startedAt: NOW,
    saved: [],
    rulesAdded: 0,
    ...overrides,
  };
}

describe('scoreCase', () => {
  it('scores a perfect run: everything expected was saved correctly', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'personal',
      message: 'remind me tomorrow at 9am to call the dentist',
      expect: [{ kind: 'task', match: ['dentist'], remind: 'tomorrow 09:00' }],
    };
    const r = run({
      saved: [
        saved({ text: 'Call the dentist', reminderLocal: fakeResolveTime('tomorrow 09:00', NOW) }),
      ],
    });
    const score = scoreCase(c, r, opts);
    expect(score.expected).toBe(1);
    expect(score.matched).toBe(1);
    expect(score.saved).toBe(1);
    expect(score.correctSaves).toBe(1);
    expect(score.reminderExpected).toBe(1);
    expect(score.reminderCorrect).toBe(1);
    expect(score.problems).toEqual([]);
  });

  it('counts an expected item that was never saved as missed, not matched', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'personal',
      message: 'remind me to call the dentist',
      expect: [{ kind: 'task', match: ['dentist'] }],
    };
    const r = run({ saved: [] });
    const score = scoreCase(c, r, opts);
    expect(score.expected).toBe(1);
    expect(score.matched).toBe(0);
    expect(score.correctSaves).toBe(0);
    expect(score.problems.some((p) => p.startsWith('missing:'))).toBe(true);
  });

  it('flags a saved item nothing expected as an extra, incorrect save', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'nosave',
      message: "it's raining today",
      expect: [],
    };
    const r = run({ saved: [saved({ text: 'It is raining' })] });
    const score = scoreCase(c, r, opts);
    expect(score.expected).toBe(0);
    expect(score.matched).toBe(0);
    expect(score.saved).toBe(1);
    expect(score.correctSaves).toBe(0);
    expect(score.problems.some((p) => p.startsWith('unexpected save:'))).toBe(true);
  });

  it('never matches a task to a follow_up expectation even if the text matches', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'follow_up',
      message: "I'm waiting on Alex for the resume",
      expect: [{ kind: 'follow_up', match: ['resume'], person: 'Alex', direction: 'waiting' }],
    };
    const r = run({
      saved: [saved({ kind: 'task', text: 'Resume for Alex', person: 'Alex' })],
    });
    const score = scoreCase(c, r, opts);
    expect(score.matched).toBe(0);
    expect(score.correctSaves).toBe(0);
    // The saved task is left unmatched -> reported as an extra save, not silently dropped.
    expect(score.problems.some((p) => p.startsWith('unexpected save:'))).toBe(true);
  });

  it('matches on a wrong reminder time but still counts the save as matched and correct', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'personal',
      message: 'remind me tomorrow at 9am to call the dentist',
      expect: [{ kind: 'task', match: ['dentist'], remind: 'tomorrow 09:00' }],
    };
    const r = run({
      saved: [saved({ text: 'Call the dentist', reminderLocal: '2026-10-01 11:00' })],
    });
    const score = scoreCase(c, r, opts);
    expect(score.matched).toBe(1);
    expect(score.correctSaves).toBe(1); // remind correctness does not gate correctSaves
    expect(score.reminderExpected).toBe(1);
    expect(score.reminderCorrect).toBe(0);
    expect(score.problems.some((p) => p.includes('wrong reminder time'))).toBe(true);
  });

  it('applies the default 3-minute tolerance to relative reminder forms', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'personal',
      message: 'remind me in 20 minutes to take the laundry out',
      expect: [{ kind: 'task', match: ['laundry'], remind: '+20m' }],
    };
    const exact = fakeResolveTime('+20m', NOW);
    const twoMinLate = fakeResolveTime('+22m', NOW);
    const rGood = run({
      saved: [saved({ text: 'Take the laundry out', reminderLocal: twoMinLate })],
    });
    const scoreGood = scoreCase(c, rGood, opts);
    expect(scoreGood.reminderCorrect).toBe(1);

    const fourMinLate = fakeResolveTime('+24m', NOW);
    const rBad = run({
      saved: [saved({ text: 'Take the laundry out', reminderLocal: fourMinLate })],
    });
    const scoreBad = scoreCase(c, rBad, opts);
    expect(scoreBad.reminderCorrect).toBe(0);
    expect(exact).toBeTruthy();
  });

  it('reports a forbidden word found in a saved item', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'sensitive',
      message: 'my bank account number is 4471002983',
      expect: [],
      forbid: ['4471002983'],
    };
    const r = run({ saved: [saved({ text: 'Account number 4471002983' })] });
    const score = scoreCase(c, r, opts);
    expect(score.forbiddenHits).toEqual(['4471002983']);
    expect(score.problems.some((p) => p.includes('forbidden word'))).toBe(true);
  });

  it('does not report a forbidden hit when the word never appears', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'sensitive',
      message: 'my bank account number is 4471002983',
      expect: [],
      forbid: ['4471002983'],
    };
    const r = run({ saved: [] });
    const score = scoreCase(c, r, opts);
    expect(score.forbiddenHits).toEqual([]);
  });

  it('counts every expected item as missed when the run errored', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'personal',
      message: 'remind me to call the dentist',
      expect: [
        { kind: 'task', match: ['dentist'] },
        { kind: 'task', match: ['vet'] },
      ],
    };
    const r = run({ error: 'mcp session timed out', saved: [] });
    const score = scoreCase(c, r, opts);
    expect(score.expected).toBe(2);
    expect(score.matched).toBe(0);
    expect(score.correctSaves).toBe(0);
    expect(score.problems.some((p) => p.startsWith('run error:'))).toBe(true);
  });

  it('scores nothing-expected-nothing-saved as a clean pass with no problems', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'nosave',
      message: "I'm so tired today",
      expect: [],
    };
    const r = run({ saved: [] });
    const score = scoreCase(c, r, opts);
    expect(score.expected).toBe(0);
    expect(score.saved).toBe(0);
    expect(score.matched).toBe(0);
    expect(score.correctSaves).toBe(0);
    expect(score.problems).toEqual([]);
  });

  it('matches a fact by person even when the match words are not in the text', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'people',
      message: 'my sister Priya moved to Denver',
      expect: [{ kind: 'fact', match: ['denver'], person: 'Priya' }],
    };
    const r = run({
      saved: [saved({ kind: 'fact', text: 'Moved to a new city', person: 'Priya' })],
    });
    const score = scoreCase(c, r, opts);
    expect(score.matched).toBe(1);
  });

  it('does not require attribute match for a follow_up direction mismatch to still count as matched', () => {
    const c: EvalCase = {
      id: 'c1',
      category: 'follow_up',
      message: 'waiting on Alex for the resume',
      expect: [{ kind: 'follow_up', match: ['resume'], person: 'Alex', direction: 'waiting' }],
    };
    const r = run({
      saved: [
        saved({ kind: 'follow_up', text: 'Alex resume', person: 'Alex', direction: 'promised' }),
      ],
    });
    const score = scoreCase(c, r, opts);
    expect(score.matched).toBe(1);
    expect(score.correctSaves).toBe(0); // wrong direction -> matched but not correct
    expect(score.problems.some((p) => p.includes('wrong direction'))).toBe(true);
  });
});

describe('scoreAll / formatReport', () => {
  it('aggregates recall, precision and reminder accuracy across cases', () => {
    const cases: EvalCase[] = [
      {
        id: 'a',
        category: 'personal',
        message: 'remind me tomorrow at 9am to call the dentist',
        expect: [{ kind: 'task', match: ['dentist'], remind: 'tomorrow 09:00' }],
      },
      {
        id: 'b',
        category: 'nosave',
        message: "it's raining",
        expect: [],
      },
    ];
    const runs: CaseRun[] = [
      run({
        caseId: 'a',
        saved: [
          saved({
            text: 'Call the dentist',
            reminderLocal: fakeResolveTime('tomorrow 09:00', NOW),
          }),
        ],
      }),
      run({ caseId: 'b', saved: [] }),
    ];
    const report = scoreAll(cases, runs, opts);
    expect(report.recall).toBe(1);
    expect(report.precision).toBe(1);
    expect(report.reminderAccuracy).toBe(1);
    expect(report.passed).toBe(true);
    expect(report.totals.cases).toBe(2);

    const text = formatReport(report);
    expect(text).toContain('recall 100% (1/1)');
    expect(text).toContain('precision 100% (1/1)');
    expect(text).toContain('reminder times 100% (1/1)');
    expect(text).toContain('PASS');
  });

  it('fails when precision drops below target because of an extra save', () => {
    const cases: EvalCase[] = [
      { id: 'a', category: 'nosave', message: "it's raining", expect: [] },
    ];
    const runs: CaseRun[] = [run({ caseId: 'a', saved: [saved({ text: 'Rain forecast' })] })];
    const report = scoreAll(cases, runs, opts);
    expect(report.precision).toBe(0);
    expect(report.passed).toBe(false);
    expect(formatReport(report)).toContain('FAIL');
  });

  it('treats precision as 1 when nothing at all was saved', () => {
    const cases: EvalCase[] = [{ id: 'a', category: 'nosave', message: 'x', expect: [] }];
    const runs: CaseRun[] = [run({ caseId: 'a', saved: [] })];
    const report = scoreAll(cases, runs, opts);
    expect(report.precision).toBe(1);
  });

  it('defaults a case with no matching run to a full miss', () => {
    const cases: EvalCase[] = [
      { id: 'a', category: 'personal', message: 'x', expect: [{ kind: 'task', match: ['x'] }] },
    ];
    const report = scoreAll(cases, [], opts);
    expect(report.cases[0]?.problems).toContain('no run found for case');
    expect(report.recall).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cases.json validation
// ---------------------------------------------------------------------------

const casesPath = fileURLToPath(new URL('../../eval/cases.json', import.meta.url));
const rawCases = JSON.parse(readFileSync(casesPath, 'utf8')) as EvalCase[];

const ALLOWED_CATEGORIES: Category[] = [
  'personal',
  'appointment',
  'follow_up',
  'people',
  'profile',
  'coding',
  'learning',
  'voice',
  'nosave',
  'rule',
  'sensitive',
  'mixed',
];

const WEEKDAY_RE = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const HHMM_RE = '(?:[01]\\d|2[0-3]):[0-5]\\d';
const AMPM_RE = '(?:1[0-2]|[1-9])(?::[0-5]\\d)?\\s?(?:am|pm)|noon';
const CLOCK_RE = `(?:${HHMM_RE}|${AMPM_RE})`;

const TIME_EXPRESSION_RE = new RegExp(
  '^(?:' +
    `\\d{4}-\\d{2}-\\d{2}[ T]${CLOCK_RE}(?::\\d{2})?` + // YYYY-MM-DD HH:mm (+ optional seconds for ISO)
    '|\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})' + // ISO with offset
    `|(?:today|tonight|tomorrow) ${CLOCK_RE}` +
    `|(?:next )?${WEEKDAY_RE} ${CLOCK_RE}` +
    '|\\+(?:\\d+d)?(?:\\d+h)?(?:\\d+m)?' + // relative, at least one component enforced below
    `|\\+\\d+d ${CLOCK_RE}` +
    ')$',
  'i',
);

const DATE_EXPRESSION_RE = new RegExp(
  `^(?:\\d{4}-\\d{2}-\\d{2}|today|tomorrow|${WEEKDAY_RE})$`,
  'i',
);

function isValidTimeExpression(expr: string): boolean {
  if (/^\+\s*$/.test(expr)) return false;
  if (expr === '+') return false;
  if (/^\+(?:\d+[dhm])*$/.test(expr) && !/\d/.test(expr)) return false;
  return TIME_EXPRESSION_RE.test(expr);
}

describe('cases.json', () => {
  it('has between 40 and 45 cases', () => {
    expect(rawCases.length).toBeGreaterThanOrEqual(40);
    expect(rawCases.length).toBeLessThanOrEqual(45);
  });

  it('has unique ids', () => {
    const ids = rawCases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses only allowed categories', () => {
    for (const c of rawCases) {
      expect(ALLOWED_CATEGORIES).toContain(c.category);
    }
  });

  it('every case has a non-empty message and an expect array', () => {
    for (const c of rawCases) {
      expect(typeof c.message).toBe('string');
      expect(c.message.length).toBeGreaterThan(0);
      expect(Array.isArray(c.expect)).toBe(true);
    }
  });

  it('every expected remind/due/appointmentStart uses a form from docs/tools.md', () => {
    for (const c of rawCases) {
      for (const e of c.expect) {
        if (e.remind !== undefined) {
          expect(isValidTimeExpression(e.remind), `${c.id} remind "${e.remind}"`).toBe(true);
        }
        if (e.appointmentStart !== undefined) {
          expect(
            isValidTimeExpression(e.appointmentStart),
            `${c.id} appointmentStart "${e.appointmentStart}"`,
          ).toBe(true);
        }
        if (e.due !== undefined) {
          expect(DATE_EXPRESSION_RE.test(e.due), `${c.id} due "${e.due}"`).toBe(true);
        }
      }
    }
  });

  it('follow_up and fact expectations that carry a person also carry it non-empty', () => {
    for (const c of rawCases) {
      for (const e of c.expect) {
        if (e.person !== undefined) {
          expect(e.person.length).toBeGreaterThan(0);
        }
        if (e.kind === 'follow_up') {
          expect(e.person, `${c.id} follow_up requires person`).toBeDefined();
          expect(e.direction, `${c.id} follow_up requires direction`).toBeDefined();
        }
      }
    }
  });
});
