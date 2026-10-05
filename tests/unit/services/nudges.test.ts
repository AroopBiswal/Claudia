import { afterEach, describe, expect, it } from 'vitest';
import type { IndexedItem } from '../../../src/engine/index.ts';
import { extractItems } from '../../../src/vault/items.ts';
import { noteBasename } from '../../../src/vault/layout.ts';
import { parseNote } from '../../../src/vault/note.ts';
import { nudgeTimeFor, nudgesDue } from '../../../src/services/nudges.ts';
import { DEFAULT_SETTINGS } from '../../../src/vault/settings.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

function effectiveReminder(reminder: string | null, snooze: string | null): string | null {
  if (reminder === null && snooze === null) return null;
  if (snooze === null) return reminder;
  if (reminder === null) return snooze;
  return snooze > reminder ? snooze : reminder;
}

/** Builds an IndexedItem the way engine/index.ts would, for testing pure logic without SQLite. */
function itemAt(path: string, heading: string, text: string): IndexedItem {
  const item = extractItems(path, parseNote(`# ${heading}\n\n${text}\n`))[0];
  if (!item) throw new Error('no item');
  return {
    ...item,
    effectiveReminder: effectiveReminder(item.reminder, item.snooze),
    noteTitle: noteBasename(item.path),
  };
}

function followUp(text: string): IndexedItem {
  return itemAt('Tasks/Follow-ups.md', 'Follow-ups', text);
}

function task(text: string): IndexedItem {
  return itemAt('Tasks/To do.md', 'To do', text);
}

describe('nudgeTimeFor', () => {
  it('with 📅: nudges on that date at the nudge time, once the date has come', () => {
    const item = followUp(
      '- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 📅 2026-10-02 ^t4m1q',
    );
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-10-01')).toBeNull();
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-10-02')).toBe('2026-10-02 09:00');
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-10-15')).toBe('2026-10-02 09:00');
  });

  it('without 📅: nudges N days after ➕, then every N days while open (5-day default cadence)', () => {
    const item = followUp('- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 ^t4m1q');
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-09-24')).toBeNull();
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-09-25')).toBe('2026-09-25 09:00');
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-09-27')).toBe('2026-09-25 09:00');
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-09-29')).toBe('2026-09-25 09:00');
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-09-30')).toBe('2026-09-30 09:00');
  });

  it('uses only the date part when ➕ carries a time', () => {
    const dateOnly = followUp(
      '- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 ^t4m1q',
    );
    const withTime = followUp(
      '- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 23:45 ^t4m1q',
    );
    expect(withTime.created).toBe('2026-09-20 23:45');
    for (const today of ['2026-09-24', '2026-09-25', '2026-09-29', '2026-09-30', '2026-10-15']) {
      expect(nudgeTimeFor(withTime, DEFAULT_SETTINGS, today)).toBe(
        nudgeTimeFor(dateOnly, DEFAULT_SETTINGS, today),
      );
    }
    expect(nudgeTimeFor(withTime, DEFAULT_SETTINGS, '2026-09-25')).toBe('2026-09-25 09:00');
  });

  it('honors a custom "Waiting-on nudge after" cadence', () => {
    const item = followUp('- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 ^t4m1q');
    const settings = { ...DEFAULT_SETTINGS, waitingNudgeDays: 3 };
    expect(nudgeTimeFor(item, settings, '2026-09-22')).toBeNull();
    expect(nudgeTimeFor(item, settings, '2026-09-23')).toBe('2026-09-23 09:00');
    expect(nudgeTimeFor(item, settings, '2026-09-25')).toBe('2026-09-23 09:00');
    expect(nudgeTimeFor(item, settings, '2026-09-26')).toBe('2026-09-26 09:00');
  });

  it('is null for a follow-up with a reminder (⏰ replaces nudges)', () => {
    const item = followUp(
      '- [ ] Waiting on [[Alex]]: resume draft #waiting ⏰ 2026-09-25 09:00 ➕ 2026-09-20 ^t4m1q',
    );
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-09-30')).toBeNull();
  });

  it('is null once the follow-up is done', () => {
    const item = followUp(
      '- [x] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 ✅ 2026-09-27 ^t4m1q',
    );
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-09-30')).toBeNull();
  });

  it('is null with neither ➕ nor 📅', () => {
    const item = followUp('- [ ] Waiting on [[Alex]]: resume draft #waiting ^t4m1q');
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-09-30')).toBeNull();
  });

  it('is null for a non follow-up item', () => {
    const item = task('- [ ] Water plants ➕ 2026-09-01 ^t0001');
    expect(nudgeTimeFor(item, DEFAULT_SETTINGS, '2026-09-30')).toBeNull();
  });
});

describe('nudgesDue', () => {
  const files = {
    'Tasks/Follow-ups.md': [
      '# Follow-ups',
      '',
      '- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 ^t4m1q',
      '- [ ] Send [[Alex]] the referral link #promised ➕ 2026-09-26 📅 2026-10-02 ^t4m2w',
      '- [ ] Waiting on [[Alex]]: reply #waiting ⏰ 2026-09-30 09:00 ➕ 2026-09-01 ^t4m3x',
      '',
    ].join('\n'),
  };

  it('lists open follow-ups whose nudge time has passed and not fired yet', async () => {
    t = await makeTestContext({ now: '2026-09-25T16:00:00Z', files }); // 2026-09-25 09:00 Pacific
    const due = nudgesDue(t.ctx);
    expect(due.map((d) => d.item.id)).toEqual(['t4m1q']);
    expect(due[0]?.dueLocal).toBe('2026-09-25 09:00');
    expect(due[0]?.key).toBe('nudge:t4m1q:2026-09-25');
  });

  it('excludes a nudge whose key has already fired', async () => {
    t = await makeTestContext({ now: '2026-09-25T16:00:00Z', files });
    t.ctx.state.markFired('nudge:t4m1q:2026-09-25', 'nudge');
    const due = nudgesDue(t.ctx);
    expect(due).toHaveLength(0);
  });

  it('excludes follow-ups not yet due and those with a reminder', async () => {
    t = await makeTestContext({ now: '2026-09-21T16:00:00Z', files }); // before any nudge
    const due = nudgesDue(t.ctx);
    expect(due).toHaveLength(0);
  });

  it('accepts an explicit nowLocal override', async () => {
    // 2026-09-25 08:59 Pacific: the day of the first nudge, one minute before it fires.
    t = await makeTestContext({ now: '2026-09-25T15:59:00Z', files });
    expect(nudgesDue(t.ctx)).toHaveLength(0);
    const withOverride = nudgesDue(t.ctx, { nowLocal: '2026-09-25 09:00' });
    expect(withOverride.map((d) => d.item.id)).toEqual(['t4m1q']);
  });
});
