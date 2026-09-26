import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScheduler } from '../../../src/scheduler/scheduler.ts';
import type { CalendarSync } from '../../../src/services/context.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
const backupDirs: string[] = [];

afterEach(async () => {
  await t?.cleanup();
  t = undefined;
  await Promise.all(backupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeBackupsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claudia-backups-'));
  backupDirs.push(dir);
  return dir;
}

function fakeCalendar(): CalendarSync & { reconcileCalls: number } {
  const c = {
    reconcileCalls: 0,
    upsert: () => Promise.resolve('created' as const),
    cancel: () => Promise.resolve(),
    reconcile: () => {
      c.reconcileCalls += 1;
      return Promise.resolve();
    },
  };
  return c;
}

describe('scheduler: day rollover', () => {
  it('rewrites Today.md once per new local day', async () => {
    t = await makeTestContext({ now: '2026-09-26T16:00:00Z' }); // 09:00 Pacific
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    const first = await scheduler.tick();
    expect(first.dayRolled).toBe(true);
    expect(t.ctx.state.getKv('scheduler:day')).toBe('2026-09-26');

    const same = await scheduler.tick();
    expect(same.dayRolled).toBe(false);

    t.clock.advance(24 * 60 * 60_000); // next day, same local time
    const nextDay = await scheduler.tick();
    expect(nextDay.dayRolled).toBe(true);
    expect(t.ctx.state.getKv('scheduler:day')).toBe('2026-09-27');
  });
});

describe('scheduler: nightly', () => {
  it('does not run before the nightly hour', async () => {
    t = await makeTestContext({
      now: '2026-09-26T09:59:00Z', // 02:59 Pacific
      files: {
        'Tasks/To do.md': '# To do\n\n- [x] Old completed task ✅ 2026-09-20 ^t0001\n',
      },
    });
    const backupsDir = await makeBackupsDir();
    const scheduler = createScheduler(t.ctx, { backupsDir });

    const report = await scheduler.tick();
    expect(report.nightly).toBe(false);
    expect(t.ctx.state.getKv('nightly:2026-09-26')).toBeNull();
    await expect(readdir(backupsDir)).resolves.toEqual([]);
    await expect(readFile(join(t.vault.dir, 'Tasks/Done/2026-09.md'), 'utf8')).rejects.toThrow();
  });

  it('archives completed items, backs up the vault, reconciles the calendar and refreshes the index once per date at 03:00', async () => {
    const calendar = fakeCalendar();
    t = await makeTestContext({
      now: '2026-09-26T09:59:00Z', // 02:59 Pacific: one minute before the nightly hour
      files: {
        'Tasks/To do.md': [
          '# To do',
          '',
          '- [x] Old completed task ✅ 2026-09-20 ^t0001',
          '- [ ] Still open ⏰ 2026-09-26 09:00 ^t0002',
          '',
        ].join('\n'),
      },
      calendar,
    });
    const backupsDir = await makeBackupsDir();
    const scheduler = createScheduler(t.ctx, { backupsDir });

    t.clock.set('2026-09-26T10:00:00Z'); // 03:00 Pacific
    const report = await scheduler.tick();
    expect(report.nightly).toBe(true);

    const todo = await readFile(join(t.vault.dir, 'Tasks/To do.md'), 'utf8');
    expect(todo).not.toContain('Old completed task');
    expect(todo).toContain('Still open');

    const done = await readFile(join(t.vault.dir, 'Tasks/Done/2026-09.md'), 'utf8');
    expect(done).toContain('Old completed task');
    expect(done).toContain('^t0001');

    const log = await readFile(join(t.vault.dir, 'Log/2026-09-26.md'), 'utf8');
    expect(log).toContain('archived');
    expect(log).toContain('Old completed task');

    const backups = await readdir(backupsDir);
    expect(backups).toEqual(['vault-2026-09-26']);

    expect(calendar.reconcileCalls).toBe(1);
    expect(t.ctx.state.getKv('nightly:2026-09-26')).not.toBeNull();

    // Once per date: a second tick the same day does not redo the work.
    const again = await scheduler.tick();
    expect(again.nightly).toBe(false);
    expect(calendar.reconcileCalls).toBe(1);
    expect(await readdir(backupsDir)).toEqual(['vault-2026-09-26']);

    // The next date, at the nightly hour, runs again.
    t.clock.set('2026-09-27T10:00:00Z'); // 2026-09-27 03:00 Pacific
    const nextNight = await scheduler.tick();
    expect(nextNight.nightly).toBe(true);
    expect(calendar.reconcileCalls).toBe(2);
    expect((await readdir(backupsDir)).sort()).toEqual(['vault-2026-09-26', 'vault-2026-09-27']);
  });
});
