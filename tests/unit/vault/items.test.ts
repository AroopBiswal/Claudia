import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseNote } from '../../../src/vault/note.ts';
import { extractItems } from '../../../src/vault/items.ts';

const fixturesDir = fileURLToPath(new URL('../../fixtures/vault', import.meta.url));

function load(path: string) {
  const text = readFileSync(`${fixturesDir}/${path}`, 'utf8');
  return parseNote(text);
}

function itemsFor(path: string) {
  return extractItems(path, load(path));
}

describe('extractItems: Tasks/To do.md', () => {
  const items = itemsFor('Tasks/To do.md');
  it('extracts three open tasks', () => {
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.kind === 'task' && i.status === 'open')).toBe(true);
  });
  it('carries the reminder and repeat fields', () => {
    const laundry = items.find((i) => i.id === 't2b7m');
    expect(laundry?.reminder).toBe('2026-09-27 19:00');
    expect(laundry?.repeat).toBe('every week on Sunday');
    expect(laundry?.text).toBe('Laundry');
  });
  it('carries the due field', () => {
    const passport = items.find((i) => i.id === 't8c1d');
    expect(passport?.due).toBe('2026-11-01');
  });
});

describe('extractItems: Tasks/Follow-ups.md', () => {
  const items = itemsFor('Tasks/Follow-ups.md');
  it('extracts follow-ups with direction and person link', () => {
    expect(items).toHaveLength(2);
    const waiting = items.find((i) => i.id === 't4m1q');
    expect(waiting?.kind).toBe('follow_up');
    expect(waiting?.direction).toBe('waiting');
    expect(waiting?.links).toEqual(['Alex']);
    expect(waiting?.created).toBe('2026-09-26');
    expect(waiting?.due).toBe('2026-10-02');

    const promised = items.find((i) => i.id === 't4m2w');
    expect(promised?.direction).toBe('promised');
  });
});

describe('extractItems: Tasks/Appointments.md', () => {
  const items = itemsFor('Tasks/Appointments.md');
  it('extracts one appointment with parsed date/start/end', () => {
    expect(items).toHaveLength(1);
    const appt = items[0];
    expect(appt?.kind).toBe('appointment');
    expect(appt?.appointment).toEqual({ date: '2026-09-29', start: '15:00', end: '16:00' });
    expect(appt?.id).toBe('a3k9p');
  });
});

describe('extractItems: Tasks/Done/2026-09.md', () => {
  it('extracts a done task even in the archive', () => {
    const items = itemsFor('Tasks/Done/2026-09.md');
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('task');
    expect(items[0]?.status).toBe('done');
    expect(items[0]?.done).toBe('2026-09-29');
  });
});

describe('extractItems: People/Alex.md', () => {
  const items = itemsFor('People/Alex.md');
  it('extracts three facts attributed to Alex', () => {
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.kind === 'fact')).toBe(true);
    expect(items.every((i) => i.people.includes('Alex'))).toBe(true);
  });
  it('parses the expiring fact', () => {
    const stale = items.find((i) => i.id === 'f5r8e');
    expect(stale?.expires).toBe('2026-10-15');
    expect(stale?.text).toBe('Staying in Lisbon until mid October');
  });
});

describe('extractItems: Memory/Profile.md and Memory/Topics/Travel.md', () => {
  it('extracts facts with no people attribution', () => {
    const profile = itemsFor('Memory/Profile.md');
    expect(profile).toHaveLength(2);
    expect(profile.every((i) => i.kind === 'fact' && i.people.length === 0)).toBe(true);

    const travel = itemsFor('Memory/Topics/Travel.md');
    expect(travel).toHaveLength(2);
    expect(travel.find((i) => i.id === 'f6y2x')?.expires).toBe('2026-11-01');
  });
});

describe('extractItems: _claudia/Rules.md', () => {
  it('extracts a rule with parsed keywords', () => {
    const items = itemsFor('_claudia/Rules.md');
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('rule');
    expect(items[0]?.keywords).toEqual(['therapy', 'therapist', 'counseling']);
  });
});

describe('extractItems: generated and readme notes produce no items', () => {
  it('Today.md is skipped (claudia: generated)', () => {
    expect(itemsFor('Today.md')).toEqual([]);
  });
  it('Recently captured.md is skipped (claudia: generated)', () => {
    expect(itemsFor('Recently captured.md')).toEqual([]);
  });
  it('_claudia/README.md is skipped (claudia: readme)', () => {
    expect(itemsFor('_claudia/README.md')).toEqual([]);
  });
  it('_claudia/Settings.md has no list items, so no vault items either', () => {
    expect(itemsFor('_claudia/Settings.md')).toEqual([]);
  });
});

describe('extractItems: Log notes produce no items', () => {
  it('Log/2026-09-26.md is skipped entirely', () => {
    expect(itemsFor('Log/2026-09-26.md')).toEqual([]);
  });
});

describe('extractItems: code fences are never indexed', () => {
  it('only the real task outside the fences is extracted', () => {
    const items = itemsFor('code-fence.md');
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('t1a2b');
  });
});

describe('extractItems: nested tab-indented tasks', () => {
  it('extracts all three nested tasks as generic tasks', () => {
    const items = itemsFor('nested-indented-tabs.md');
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.id)).toEqual(['t3c4d', 't5e6f', 't7g8h']);
  });
});

describe('extractItems: numbered list tasks', () => {
  it('extracts numbered-bullet tasks', () => {
    const items = itemsFor('numbered-list.md');
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id)).toEqual(['t1n2n', 't3n4n']);
  });
});

describe('extractItems: emoji variant without VS16', () => {
  it('still classifies as an appointment', () => {
    const items = itemsFor('emoji-variant.md');
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('appointment');
    expect(items[0]?.appointment).toEqual({ date: '2026-09-30', start: '10:00', end: '10:30' });
  });
});

describe('extractItems: malformed lines still index sensibly', () => {
  it('handles an empty task box, a bad status box, and an invalid field value', () => {
    const items = itemsFor('malformed.md');
    // - [ ] with nothing -> open task, empty text, no id
    const empty = items.find((i) => i.kind === 'task' && i.text === '' && i.id === null);
    expect(empty).toBeDefined();
    // - [xx] ... is not a task, and it's not in a fact/rule folder, so it produces no item
    expect(items.some((i) => i.text.includes('Two chars'))).toBe(false);
    // stray 🚫 with no real rule context still round-trips as a fact-less plain line (no folder match) -> no item
    // (this file lives at the vault root, not People/Memory/Rules, so non-task lines aren't indexed)
  });
});

describe('extractItems: callouts and tables do not produce spurious items', () => {
  it('only the real task line is extracted', () => {
    const items = itemsFor('callouts-tables.md');
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('t2q3r');
    expect(items[0]?.links).toEqual([]);
  });
});

describe('extractItems: ignored paths', () => {
  it('returns nothing for dot-folders', () => {
    const note = parseNote('- [ ] hidden task ^t1a1a\n');
    expect(extractItems('.obsidian/workspace.md', note)).toEqual([]);
    expect(extractItems('.trash/deleted.md', note)).toEqual([]);
  });
});
