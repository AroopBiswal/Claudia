import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openIndex, type Index } from '../../../src/engine/index.ts';
import { makeScratchVault, type ScratchVault } from '../../helpers/scratch-vault.ts';

const fixturesVault = fileURLToPath(new URL('../../fixtures/vault', import.meta.url));

describe('openIndex: rebuild over the contract example vault', () => {
  let idx: Index;

  beforeEach(async () => {
    idx = openIndex({
      dbPath: ':memory:',
      vaultDir: fixturesVault,
      now: () => new Date('2026-09-26T18:00:00.000Z'),
    });
    await idx.rebuild();
  });

  afterEach(() => {
    idx.close();
  });

  it('indexes every markdown note, skipping nothing that should be walked', () => {
    const stats = idx.stats();
    expect(stats.notes).toBeGreaterThan(0);
    expect(stats.items).toBeGreaterThan(0);
    expect(stats.lastRebuild).toBe('2026-09-26T18:00:00.000Z');
  });

  it('extracts the three To do tasks, the two follow-ups and the one appointment', () => {
    expect(idx.itemsInNote('Tasks/To do.md')).toHaveLength(3);
    expect(idx.itemsInNote('Tasks/Follow-ups.md')).toHaveLength(2);
    expect(idx.itemsInNote('Tasks/Appointments.md')).toHaveLength(1);
  });

  it('generated, readme and Log notes contribute no items', () => {
    expect(idx.itemsInNote('Today.md')).toHaveLength(0);
    expect(idx.itemsInNote('Recently captured.md')).toHaveLength(0);
    expect(idx.itemsInNote('_claudia/README.md')).toHaveLength(0);
    expect(idx.itemsInNote('Log/2026-09-26.md')).toHaveLength(0);
  });

  it('settings and rules are readable from the index', () => {
    const { settings, warnings } = idx.settings();
    expect(settings.timeZone).toBe('America/Los_Angeles');
    expect(settings.briefTime).toBe('07:30');
    expect(warnings).toEqual([]);

    const rules = idx.rules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      id: 'r1a2b',
      text: 'Nothing about my therapy sessions',
      keywords: ['therapy', 'therapist', 'counseling'],
    });
  });

  it('lists People notes', () => {
    expect(idx.people()).toEqual(['Alex']);
  });

  describe('duplicate ids and getItem', () => {
    it('t9x2k is duplicated: open in To do.md, done in the Done archive', () => {
      expect(idx.duplicateIds()).toEqual(['t9x2k']);
    });

    it('getItem prefers the open copy over the done one', () => {
      const item = idx.getItem('t9x2k');
      expect(item).not.toBeNull();
      expect(item?.status).toBe('open');
      expect(item?.path).toBe('Tasks/To do.md');
    });

    it('hasId is true for any id present, even a duplicated one', () => {
      expect(idx.hasId('t9x2k')).toBe(true);
      expect(idx.hasId('doesnotexist')).toBe(false);
    });

    it('getItem returns null for an unknown id', () => {
      expect(idx.getItem('zzzzz')).toBeNull();
    });
  });

  describe('effectiveReminder', () => {
    it('is the reminder when there is no snooze', () => {
      const item = idx.getItem('t9x2k');
      expect(item?.effectiveReminder).toBe('2026-09-29 09:00');
    });

    it('is null for an item with neither reminder nor snooze', () => {
      const item = idx.getItem('t8c1d'); // Renew passport, due only
      expect(item?.effectiveReminder).toBeNull();
    });
  });

  describe('people resolution', () => {
    it('resolves a follow-up link against the existing People/Alex.md note', () => {
      const item = idx.getItem('t4m1q');
      expect(item?.people).toEqual(['Alex']);
    });

    it('a fact in a person note carries that person even without a link', () => {
      const item = idx.getItem('f1a9z');
      expect(item?.people).toEqual(['Alex']);
    });
  });

  describe('openReminders / openDue / appointments / followUps / facts / staleFacts', () => {
    it('openReminders returns open task/follow-up items with an effective reminder, sorted', () => {
      const items = idx.openReminders();
      expect(items.every((i) => i.kind === 'task' || i.kind === 'follow_up')).toBe(true);
      expect(items.every((i) => i.effectiveReminder !== null)).toBe(true);
      const times = items.map((i) => i.effectiveReminder);
      expect([...times].sort()).toEqual(times);
    });

    it('openReminders respects an inclusive range', () => {
      const items = idx.openReminders({ from: '2026-09-29 09:00', to: '2026-09-29 09:00' });
      expect(items.map((i) => i.id)).toEqual(['t9x2k']);
    });

    it('openDue returns open items with a due date in range', () => {
      const items = idx.openDue({ from: '2026-11-01', to: '2026-11-01' });
      expect(items.map((i) => i.id)).toEqual(['t8c1d']);
    });

    it('appointments returns items by date within range, sorted by date and start', () => {
      // Tasks/Appointments.md has a3k9p (Sep 29); emoji-variant.md has a1v2w (Sep 30, no VS16 on 🗓).
      const items = idx.appointments({ from: '2026-09-01', to: '2026-09-30' });
      expect(items.map((i) => i.id)).toEqual(['a3k9p', 'a1v2w']);
    });

    it('appointments excludes done ones unless includeDone is set', () => {
      const items = idx.appointments({ from: '2026-01-01', to: '2026-12-31' });
      expect(items).toHaveLength(2);
    });

    it('followUps returns the two open follow-ups with their direction', () => {
      const items = idx.followUps();
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.direction).sort()).toEqual(['promised', 'waiting']);
    });

    it('facts returns every fact across People and Memory notes', () => {
      const items = idx.facts();
      expect(items.length).toBeGreaterThanOrEqual(7);
      expect(items.every((i) => i.kind === 'fact')).toBe(true);
    });

    it("facts filtered by person returns only that person's facts", () => {
      const items = idx.facts({ person: 'Alex' });
      expect(items).toHaveLength(3);
      expect(items.every((i) => i.people.includes('Alex'))).toBe(true);
    });

    it('facts person filter is case-insensitive', () => {
      expect(idx.facts({ person: 'aLeX' })).toHaveLength(3);
    });

    it('staleFacts returns facts whose expiry has passed relative to "today"', () => {
      // Alex's Lisbon fact expires 2026-10-15; Travel's passport fact expires 2026-11-01.
      expect(idx.staleFacts('2026-10-01').map((f) => f.id)).toEqual([]);
      expect(idx.staleFacts('2026-10-20').map((f) => f.id)).toEqual(['f5r8e']);
      expect(
        idx
          .staleFacts('2026-12-01')
          .map((f) => f.id)
          .sort(),
      ).toEqual(['f5r8e', 'f6y2x']);
    });
  });

  describe('search', () => {
    it('finds an item by a single keyword', () => {
      const { total, results } = idx.search({ query: 'dentist' });
      expect(total).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.id === 't9x2k')).toBe(true);
    });

    it('AND-combines multiple tokens by default', () => {
      const { results } = idx.search({ query: 'dentist reschedule' });
      expect(results.map((r) => r.id)).toContain('t9x2k');
    });

    it('falls back to OR when the AND query has zero hits', () => {
      // "dentist" only appears on t9x2k / a3k9p; "passport" only on t8c1d and the Travel fact.
      // No single item contains both, so AND must yield zero and OR must recover matches.
      const and = idx.search({ query: 'dentist passport' });
      expect(and.results.length).toBeGreaterThan(0);
      const ids = and.results.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining(['t9x2k', 'a3k9p', 't8c1d']));
    });

    it('filters by kind', () => {
      const { results } = idx.search({ query: 'dentist', kinds: ['appointment'] });
      expect(results.every((r) => r.kind === 'appointment')).toBe(true);
      expect(results.map((r) => r.id)).toEqual(['a3k9p']);
    });

    it('excludes done/cancelled items unless includeDone is set', () => {
      const without = idx.search({ query: 'dentist', kinds: ['task'] });
      expect(without.results.map((r) => r.id)).toEqual(['t9x2k']);

      const withDone = idx.search({ query: 'dentist', kinds: ['task'], includeDone: true });
      // Both the open To-do copy and the archived Done copy share id t9x2k, so the
      // duplicate shows up twice when done items are included.
      expect(withDone.results.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by person', () => {
      const { results } = idx.search({ query: '', person: 'Alex' });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.people.includes('Alex'))).toBe(true);
    });

    it('an empty query with no person lists items subject to the other filters', () => {
      const { results } = idx.search({ query: '', kinds: ['rule'] });
      expect(results.map((r) => r.id)).toEqual(['r1a2b']);
    });

    it('clamps limit to the 1..50 range and defaults to 10', () => {
      const withoutLimit = idx.search({ query: '' });
      expect(withoutLimit.results.length).toBeLessThanOrEqual(10);

      const clampedHigh = idx.search({ query: '', limit: 1000 });
      expect(clampedHigh.results.length).toBeLessThanOrEqual(50);

      const clampedLow = idx.search({ query: '', limit: 0 });
      expect(clampedLow.results.length).toBeLessThanOrEqual(1);
    });

    it('never lets raw query text break the FTS syntax', () => {
      expect(() => idx.search({ query: '"unterminated OR *' })).not.toThrow();
      expect(() => idx.search({ query: 'a AND (b OR c' })).not.toThrow();
    });
  });
});

describe('openIndex: people resolution updates as People notes come and go', () => {
  let idx: Index;

  beforeEach(() => {
    idx = openIndex({ dbPath: ':memory:', vaultDir: '/tmp/unused-for-indexText' });
  });

  afterEach(() => {
    idx.close();
  });

  it('resolves a link to a person note created after the linking item was indexed', () => {
    idx.indexText(
      'Tasks/Follow-ups.md',
      '# Follow-ups\n\n- [ ] Waiting on [[Jamie]]: reply #waiting ➕ 2026-09-01 ^t1a1a\n',
      1000,
    );
    expect(idx.getItem('t1a1a')?.people).toEqual([]);

    idx.indexText('People/Jamie.md', '# Jamie\n\n- Met at a conference ^f1a1a\n', 2000);
    expect(idx.getItem('t1a1a')?.people).toEqual(['Jamie']);
    expect(idx.people()).toEqual(['Jamie']);
  });

  it('link resolution is case-insensitive but returns the canonical note name', () => {
    idx.indexText('People/Alex Rivera.md', '# Alex Rivera\n\n- Coworker ^f0001\n', 1000);
    idx.indexText(
      'Tasks/To do.md',
      '# To do\n\n- [ ] Ping [[alex rivera]] about the doc ^t0001\n',
      2000,
    );
    expect(idx.getItem('t0001')?.people).toEqual(['Alex Rivera']);
  });
});

describe('openIndex: settings and rules track edits and deletion', () => {
  let idx: Index;

  beforeEach(() => {
    idx = openIndex({ dbPath: ':memory:', vaultDir: '/tmp/unused-for-indexText' });
  });

  afterEach(() => {
    idx.close();
  });

  it('surfaces a settings warning and falls back to the default for an invalid value', () => {
    idx.indexText(
      '_claudia/Settings.md',
      '---\nclaudia: settings\n---\n# Settings\n\n- Brief time: not-a-time\n',
      1000,
    );
    const { settings, warnings } = idx.settings();
    expect(settings.briefTime).toBe('07:30');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/Brief time/);
  });

  it('falls back to defaults with no warnings when Settings.md is missing or removed', () => {
    expect(idx.settings().warnings).toEqual([]);
    idx.indexText(
      '_claudia/Settings.md',
      '---\nclaudia: settings\n---\n# Settings\n\n- Nudge time: 10:15\n',
      1000,
    );
    expect(idx.settings().settings.nudgeTime).toBe('10:15');
    idx.removeFile('_claudia/Settings.md');
    const afterRemoval = idx.settings();
    expect(afterRemoval.warnings).toEqual([]);
    expect(afterRemoval.settings.nudgeTime).toBe('09:00');
  });

  it('rules() reflects edits to Rules.md, including removal', () => {
    idx.indexText(
      '_claudia/Rules.md',
      '---\nclaudia: rules\n---\n# Never-save rules\n\n- Nothing about my salary 🚫 salary, pay ^r0001\n',
      1000,
    );
    expect(idx.rules()).toHaveLength(1);
    idx.removeFile('_claudia/Rules.md');
    expect(idx.rules()).toHaveLength(0);
  });
});

describe('openIndex: filesystem-driven rebuild/refresh/reindexFile on a scratch vault', () => {
  let vault: ScratchVault;
  let idx: Index;

  afterEach(async () => {
    idx.close();
    await vault.cleanup();
  });

  it('skips an iCloud conflict copy whose base exists, and indexes it once the base is gone', async () => {
    vault = await makeScratchVault({
      'Tasks/To do.md': '# To do\n\n- [ ] Task A ^ta001\n',
      'Tasks/To do 2.md': '# To do\n\n- [ ] Task A copy ^ta001\n- [ ] Extra ^ta002\n',
    });
    idx = openIndex({ dbPath: ':memory:', vaultDir: vault.dir });

    const rebuilt = await idx.rebuild();
    expect(rebuilt.notes).toBe(1);
    expect(idx.notePaths()).toEqual(['Tasks/To do.md']);

    await vault.remove('Tasks/To do.md');
    const changed = await idx.refresh();
    expect(changed.sort()).toEqual(['Tasks/To do 2.md', 'Tasks/To do.md']);
    expect(idx.notePaths()).toEqual(['Tasks/To do 2.md']);
    expect(
      idx
        .itemsInNote('Tasks/To do 2.md')
        .map((i) => i.id)
        .sort(),
    ).toEqual(['ta001', 'ta002']);
  });

  it('skips .obsidian, .trash and dot-folders entirely', async () => {
    vault = await makeScratchVault({
      'Tasks/To do.md': '# To do\n\n- [ ] Task A ^ta001\n',
      '.obsidian/workspace.md': '# should not be indexed\n\n- [ ] hidden ^hz001\n',
      '.trash/gone.md': '# gone\n\n- [ ] hidden ^hz002\n',
      '.dotdir/nested.md': '# hidden\n\n- [ ] hidden ^hz003\n',
    });
    idx = openIndex({ dbPath: ':memory:', vaultDir: vault.dir });
    await idx.rebuild();
    expect(idx.notePaths()).toEqual(['Tasks/To do.md']);
    expect(idx.hasId('hz001')).toBe(false);
    expect(idx.hasId('hz002')).toBe(false);
    expect(idx.hasId('hz003')).toBe(false);
  });

  it('refresh reindexes an edited file and removes a deleted one', async () => {
    vault = await makeScratchVault({
      'Tasks/To do.md': '# To do\n\n- [ ] Task A ^ta001\n- [ ] Task B ^ta002\n',
    });
    idx = openIndex({ dbPath: ':memory:', vaultDir: vault.dir });
    await idx.rebuild();
    expect(idx.itemsInNote('Tasks/To do.md')).toHaveLength(2);

    await vault.write('Tasks/To do.md', '# To do\n\n- [ ] Task A ^ta001\n');
    let changed = await idx.refresh();
    expect(changed).toEqual(['Tasks/To do.md']);
    expect(idx.itemsInNote('Tasks/To do.md').map((i) => i.id)).toEqual(['ta001']);

    // refresh is a no-op when nothing changed
    changed = await idx.refresh();
    expect(changed).toEqual([]);

    await vault.remove('Tasks/To do.md');
    changed = await idx.refresh();
    expect(changed).toEqual(['Tasks/To do.md']);
    expect(idx.notePaths()).toEqual([]);
  });

  it('reindexFile indexes a single file and removes it if it no longer exists', async () => {
    vault = await makeScratchVault({});
    idx = openIndex({ dbPath: ':memory:', vaultDir: vault.dir });

    await vault.write('Tasks/To do.md', '# To do\n\n- [ ] Task A ^ta001\n');
    await idx.reindexFile('Tasks/To do.md');
    expect(idx.itemsInNote('Tasks/To do.md')).toHaveLength(1);

    await vault.remove('Tasks/To do.md');
    await idx.reindexFile('Tasks/To do.md');
    expect(idx.notePaths()).toEqual([]);
  });

  it('reindexFile is a no-op remove for a path that was never indexed', async () => {
    vault = await makeScratchVault({});
    idx = openIndex({ dbPath: ':memory:', vaultDir: vault.dir });
    await expect(idx.reindexFile('Tasks/Never.md')).resolves.toBeUndefined();
    expect(idx.notePaths()).toEqual([]);
  });
});

describe('openIndex: deleting and rebuilding loses nothing', () => {
  it('a fresh DB rebuilt from the same vault reproduces the same items', async () => {
    const first = openIndex({ dbPath: ':memory:', vaultDir: fixturesVault });
    await first.rebuild();
    const firstStats = first.stats();
    const firstNotes = first.notePaths();
    const firstItemsByNote = firstNotes.map((p) => first.itemsInNote(p));
    first.close();

    const second = openIndex({ dbPath: ':memory:', vaultDir: fixturesVault });
    await second.rebuild();
    expect(second.notePaths()).toEqual(firstNotes);
    expect(second.stats().notes).toBe(firstStats.notes);
    expect(second.stats().items).toBe(firstStats.items);
    for (let i = 0; i < firstNotes.length; i++) {
      const path = firstNotes[i];
      expect(path).toBeDefined();
      if (!path) continue;
      expect(second.itemsInNote(path)).toEqual(firstItemsByNote[i]);
    }
    second.close();
  });
});

describe('openIndex: rebuild equals incremental updates (randomized property test)', () => {
  function noteFor(seed: number, revision: number): string {
    const lines = [`# Note ${seed}`, ''];
    const count = 1 + ((seed + revision) % 3);
    for (let i = 0; i < count; i++) {
      const id = `p${seed}${revision}${i}`.slice(0, 5).padEnd(5, '0');
      lines.push(`- [ ] Item ${seed}-${revision}-${i} ⏰ 2026-10-0${1 + (i % 8)} 09:00 ^${id}`);
    }
    return lines.join('\n') + '\n';
  }

  it('produces the same final index via full rebuild and via incremental indexText calls', async () => {
    const vault = await makeScratchVault({});
    const incremental = openIndex({ dbPath: ':memory:', vaultDir: vault.dir });

    // A deterministic pseudo-random sequence of writes/removals across 4 notes.
    let seedState = 42;
    function nextRand(): number {
      seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
      return seedState / 0x7fffffff;
    }

    const paths = ['Tasks/To do.md', 'Tasks/Follow-ups.md', 'People/Alex.md', 'People/Sam.md'];
    let revision = 0;
    for (let step = 0; step < 30; step++) {
      const pathIdx = Math.floor(nextRand() * paths.length);
      const path = paths[pathIdx];
      if (!path) continue;
      revision++;
      if (nextRand() < 0.15) {
        await vault.remove(path);
        incremental.removeFile(path);
      } else {
        const text = path.startsWith('People/')
          ? `# ${path.split('/')[1]?.replace('.md', '')}\n\n- Fact ${revision} ^f${String(revision).padStart(4, '0')}\n`
          : noteFor(pathIdx, revision);
        await vault.write(path, text);
        incremental.indexText(path, text, revision);
      }
    }

    const rebuilt = openIndex({ dbPath: ':memory:', vaultDir: vault.dir });
    await rebuilt.rebuild();

    const incrementalPaths = incremental.notePaths();
    const rebuiltPaths = rebuilt.notePaths();
    expect(incrementalPaths.sort()).toEqual(rebuiltPaths.sort());

    for (const path of rebuiltPaths) {
      const a = incremental.itemsInNote(path).map((i) => ({ ...i }));
      const b = rebuilt.itemsInNote(path).map((i) => ({ ...i }));
      expect(a).toEqual(b);
    }

    expect(incremental.stats().items).toBe(rebuilt.stats().items);

    incremental.close();
    rebuilt.close();
    await vault.cleanup();
  });
});
