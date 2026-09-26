import type { CaseRun, EvalCase, ExpectedItem, SavedItem } from './types.ts';

export interface ScoreOptions {
  /** Resolves a time expression (docs/tools.md) against `now`, returning 'YYYY-MM-DD HH:mm'. */
  resolveTime: (expr: string, now: Date) => string;
  /** Resolves a date expression (docs/tools.md) against `now`, returning 'YYYY-MM-DD'. */
  resolveDate: (expr: string, now: Date) => string;
  zone: string;
}

export interface CaseScore {
  caseId: string;
  expected: number;
  matched: number;
  saved: number;
  correctSaves: number;
  reminderExpected: number;
  reminderCorrect: number;
  forbiddenHits: string[];
  problems: string[];
}

export interface Report {
  cases: CaseScore[];
  recall: number;
  precision: number;
  reminderAccuracy: number;
  totals: {
    cases: number;
    expected: number;
    matched: number;
    saved: number;
    correctSaves: number;
    reminderExpected: number;
    reminderCorrect: number;
    forbiddenViolations: number;
    errorCases: number;
  };
  passed: boolean;
}

const RECALL_TARGET = 0.9;
const PRECISION_TARGET = 0.95;

function normalize(s: string): string {
  return s.toLowerCase();
}

function haystackFor(item: SavedItem, includePerson: boolean): string {
  const parts = [item.text];
  if (includePerson && item.person) {
    parts.push(item.person);
  }
  if (includePerson && item.people.length > 0) {
    parts.push(...item.people);
  }
  return normalize(parts.join(' '));
}

function containsAllWords(haystack: string, words: string[]): boolean {
  return words.every((w) => haystack.includes(normalize(w)));
}

function personMatches(saved: string | null, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  if (saved === null) return false;
  const a = normalize(saved);
  const b = normalize(expected);
  return a === b || a.includes(b) || b.includes(a);
}

/** Eligibility test: could this saved item satisfy this expected item at all (kind + content)? */
function isEligible(expected: ExpectedItem, saved: SavedItem): boolean {
  if (expected.kind !== saved.kind) {
    // Explicitly: task <-> follow_up confusion is a mismatch, never a match, same for any
    // other kind pairing.
    return false;
  }
  if (expected.kind === 'fact') {
    const byPerson = expected.person !== undefined && personMatches(saved.person, expected.person);
    const byText = containsAllWords(haystackFor(saved, false), expected.match);
    return byPerson || byText;
  }
  const includePerson = expected.kind === 'follow_up';
  return containsAllWords(haystackFor(saved, includePerson), expected.match);
}

/** Checks the required attributes (not `remind`, which is scored separately). */
function requiredAttributesHold(
  expected: ExpectedItem,
  saved: SavedItem,
  now: Date,
  opts: ScoreOptions,
  problems: string[],
): boolean {
  let ok = true;
  if (expected.person !== undefined && !personMatches(saved.person, expected.person)) {
    problems.push(`wrong person: expected "${expected.person}", got "${saved.person ?? 'null'}"`);
    ok = false;
  }
  if (expected.direction !== undefined) {
    if (normalize(saved.direction ?? '') !== normalize(expected.direction)) {
      problems.push(
        `wrong direction: expected "${expected.direction}", got "${saved.direction ?? 'null'}"`,
      );
      ok = false;
    }
  }
  if (expected.due !== undefined) {
    const wantDue = opts.resolveDate(expected.due, now);
    if (saved.due !== wantDue) {
      problems.push(`wrong due: expected "${wantDue}", got "${saved.due ?? 'null'}"`);
      ok = false;
    }
  }
  if (expected.appointmentStart !== undefined) {
    const wantStart = opts.resolveTime(expected.appointmentStart, now);
    if (saved.appointmentStart !== wantStart) {
      problems.push(
        `wrong appointment start: expected "${wantStart}", got "${saved.appointmentStart ?? 'null'}"`,
      );
      ok = false;
    }
  }
  if (expected.repeat !== undefined) {
    if (!saved.repeat || !normalize(saved.repeat).includes(normalize(expected.repeat))) {
      problems.push(
        `wrong repeat: expected to contain "${expected.repeat}", got "${saved.repeat ?? 'null'}"`,
      );
      ok = false;
    }
  }
  return ok;
}

function minutesBetween(aLocal: string, bLocal: string): number | null {
  // 'YYYY-MM-DD HH:mm' -> treated as naive minutes-since-epoch-ish for diffing purposes.
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(aLocal);
  const n = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(bLocal);
  if (!m || !n) return null;
  const da = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const db = Date.UTC(Number(n[1]), Number(n[2]) - 1, Number(n[3]), Number(n[4]), Number(n[5]));
  return Math.abs(da - db) / 60000;
}

function defaultTolerance(remind: string): number {
  return remind.trim().startsWith('+') ? 3 : 0;
}

export function scoreCase(c: EvalCase, run: CaseRun, opts: ScoreOptions): CaseScore {
  const problems: string[] = [];
  const forbiddenHits: string[] = [];
  const now = run.startedAt;

  for (const word of c.forbid ?? []) {
    const hit = run.saved.some((s) => haystackFor(s, true).includes(normalize(word)));
    if (hit) {
      forbiddenHits.push(word);
      problems.push(`forbidden word found in a saved item: "${word}"`);
    }
  }

  if (run.error) {
    return {
      caseId: c.id,
      expected: c.expect.length,
      matched: 0,
      saved: run.saved.length,
      correctSaves: 0,
      reminderExpected: c.expect.filter((e) => e.remind !== undefined).length,
      reminderCorrect: 0,
      forbiddenHits,
      problems: [`run error: ${run.error}`, ...problems],
    };
  }

  const usedSaved = new Array<boolean>(run.saved.length).fill(false);
  let matched = 0;
  let correctSaves = 0;
  let reminderExpected = 0;
  let reminderCorrect = 0;

  for (const expected of c.expect) {
    let pickedIndex = -1;
    for (let i = 0; i < run.saved.length; i++) {
      if (usedSaved[i]) continue;
      const saved = run.saved[i];
      if (saved && isEligible(expected, saved)) {
        pickedIndex = i;
        break;
      }
    }
    if (pickedIndex === -1) {
      problems.push(`missing: kind=${expected.kind} match=[${expected.match.join(', ')}]`);
      continue;
    }
    usedSaved[pickedIndex] = true;
    matched++;
    const saved = run.saved[pickedIndex];
    if (!saved) continue;

    const itemProblems: string[] = [];
    const attrsOk = requiredAttributesHold(expected, saved, now, opts, itemProblems);
    if (attrsOk) {
      correctSaves++;
    } else {
      problems.push(
        ...itemProblems.map((p) => `${expected.kind} "${expected.match.join(' ')}": ${p}`),
      );
    }

    if (expected.remind !== undefined) {
      reminderExpected++;
      const wantLocal = opts.resolveTime(expected.remind, now);
      const tolerance = expected.remindToleranceMin ?? defaultTolerance(expected.remind);
      if (saved.reminderLocal === null) {
        problems.push(
          `missing reminder time for ${expected.kind} "${expected.match.join(' ')}" (expected ${wantLocal})`,
        );
      } else {
        const diff = minutesBetween(saved.reminderLocal, wantLocal);
        if (diff !== null && diff <= tolerance) {
          reminderCorrect++;
        } else {
          problems.push(
            `wrong reminder time for ${expected.kind} "${expected.match.join(' ')}": expected ${wantLocal} (+/-${tolerance}m), got ${saved.reminderLocal}`,
          );
        }
      }
    }
  }

  for (let i = 0; i < run.saved.length; i++) {
    if (!usedSaved[i]) {
      const saved = run.saved[i];
      problems.push(
        `unexpected save: kind=${saved?.kind ?? 'unknown'} text="${saved?.text ?? ''}"`,
      );
    }
  }

  return {
    caseId: c.id,
    expected: c.expect.length,
    matched,
    saved: run.saved.length,
    correctSaves,
    reminderExpected,
    reminderCorrect,
    forbiddenHits,
    problems,
  };
}

export function scoreAll(cases: EvalCase[], runs: CaseRun[], opts: ScoreOptions): Report {
  const runById = new Map(runs.map((r) => [r.caseId, r]));
  const cs: CaseScore[] = cases.map((c) => {
    const run = runById.get(c.id);
    if (!run) {
      return {
        caseId: c.id,
        expected: c.expect.length,
        matched: 0,
        saved: 0,
        correctSaves: 0,
        reminderExpected: c.expect.filter((e) => e.remind !== undefined).length,
        reminderCorrect: 0,
        forbiddenHits: [],
        problems: ['no run found for case'],
      };
    }
    return scoreCase(c, run, opts);
  });

  const totals = cs.reduce(
    (acc, s) => {
      acc.expected += s.expected;
      acc.matched += s.matched;
      acc.saved += s.saved;
      acc.correctSaves += s.correctSaves;
      acc.reminderExpected += s.reminderExpected;
      acc.reminderCorrect += s.reminderCorrect;
      if (s.forbiddenHits.length > 0) acc.forbiddenViolations++;
      if (s.problems.some((p) => p.startsWith('run error:'))) acc.errorCases++;
      return acc;
    },
    {
      cases: cs.length,
      expected: 0,
      matched: 0,
      saved: 0,
      correctSaves: 0,
      reminderExpected: 0,
      reminderCorrect: 0,
      forbiddenViolations: 0,
      errorCases: 0,
    },
  );

  const recall = totals.expected === 0 ? 1 : totals.matched / totals.expected;
  const precision = totals.saved === 0 ? 1 : totals.correctSaves / totals.saved;
  const reminderAccuracy =
    totals.reminderExpected === 0 ? 1 : totals.reminderCorrect / totals.reminderExpected;

  const passed =
    recall >= RECALL_TARGET &&
    precision >= PRECISION_TARGET &&
    reminderAccuracy === 1 &&
    totals.forbiddenViolations === 0;

  return { cases: cs, recall, precision, reminderAccuracy, totals, passed };
}

function formatPct(fraction: number): string {
  const pct = fraction * 100;
  const fixed = pct.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

export function formatReport(r: Report): string {
  const lines: string[] = [];
  lines.push(
    'case'.padEnd(16) +
      'exp'.padStart(4) +
      'match'.padStart(7) +
      'saved'.padStart(7) +
      'ok'.padStart(4) +
      'rem'.padStart(8),
  );
  for (const c of r.cases) {
    lines.push(
      c.caseId.padEnd(16) +
        String(c.expected).padStart(4) +
        String(c.matched).padStart(7) +
        String(c.saved).padStart(7) +
        String(c.correctSaves).padStart(4) +
        `${c.reminderCorrect}/${c.reminderExpected}`.padStart(8) +
        (c.problems.length > 0 ? `  ! ${c.problems.join(' | ')}` : ''),
    );
  }
  lines.push('');
  lines.push(`recall ${formatPct(r.recall)}% (${r.totals.matched}/${r.totals.expected})`);
  lines.push(`precision ${formatPct(r.precision)}% (${r.totals.correctSaves}/${r.totals.saved})`);
  lines.push(
    `reminder times ${formatPct(r.reminderAccuracy)}% (${r.totals.reminderCorrect}/${r.totals.reminderExpected})`,
  );
  if (r.totals.forbiddenViolations > 0) {
    lines.push(`forbidden word violations: ${r.totals.forbiddenViolations}`);
  }
  if (r.totals.errorCases > 0) {
    lines.push(`case errors: ${r.totals.errorCases}`);
  }
  lines.push(r.passed ? 'PASS' : 'FAIL');
  return lines.join('\n');
}
