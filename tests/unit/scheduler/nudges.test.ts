import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScheduler } from '../../../src/scheduler/scheduler.ts';
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

describe('scheduler: nudges', () => {
  it('pushes a Follow-up notification with Done and Tomorrow actions', async () => {
    t = await makeTestContext({
      now: '2026-09-25T16:00:00Z', // 2026-09-25 09:00 Pacific: the day's nudge time
      files: {
        'Tasks/Follow-ups.md':
          '# Follow-ups\n\n- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 ^t4m1q\n',
      },
    });
    t.ctx.state.markFired('brief:2026-09-25', 'brief'); // keep the brief fallback out of this test
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    const report = await scheduler.tick();
    expect(report.nudged).toEqual(['t4m1q']);
    expect(t.notifier.sent).toHaveLength(1);

    const push = t.notifier.sent[0];
    expect(push?.title).toBe('Follow-up');
    // #waiting stripped, [[Alex]] unwrapped to plain text
    expect(push?.message).toBe('Waiting on Alex: resume draft');
    expect(push?.actions?.map((a) => a.label)).toEqual(['Done', 'Tomorrow']);
    expect(push?.actions?.every((a) => a.method === 'POST')).toBe(true);
    expect(push?.click).toContain('obsidian://open');

    expect(t.ctx.state.wasFired('nudge:t4m1q:2026-09-25')).toBe(true);

    // Doesn't nudge again the same day.
    const again = await scheduler.tick();
    expect(again.nudged).toEqual([]);
    expect(t.notifier.sent).toHaveLength(1);
  });

  it('appends a "nudged" Log line', async () => {
    t = await makeTestContext({
      now: '2026-09-25T16:00:00Z',
      files: {
        'Tasks/Follow-ups.md':
          '# Follow-ups\n\n- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 ^t4m1q\n',
      },
    });
    t.ctx.state.markFired('brief:2026-09-25', 'brief');
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    await scheduler.tick();

    const log = await readFile(join(t.vault.dir, 'Log/2026-09-25.md'), 'utf8');
    expect(log).toContain('· Claudia · nudged');
    expect(log).toContain('[[Follow-ups#^t4m1q|Waiting on Alex: resume draft]]');
  });

  it('nudges again after the next cadence period', async () => {
    t = await makeTestContext({
      now: '2026-09-25T16:00:00Z',
      files: {
        'Tasks/Follow-ups.md':
          '# Follow-ups\n\n- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 ^t4m1q\n',
      },
    });
    t.ctx.state.markFired('brief:2026-09-25', 'brief');
    t.ctx.state.markFired('brief:2026-09-30', 'brief');
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    await scheduler.tick();
    expect(t.notifier.sent).toHaveLength(1);

    t.clock.set('2026-09-30T16:00:00Z'); // next 5-day cadence point: 2026-09-30 09:00 Pacific
    const report = await scheduler.tick();
    expect(report.nudged).toEqual(['t4m1q']);
    expect(t.notifier.sent).toHaveLength(2);
  });

  it('retries a failed nudge send on the next tick without marking it fired', async () => {
    t = await makeTestContext({
      now: '2026-09-25T16:00:00Z',
      files: {
        'Tasks/Follow-ups.md':
          '# Follow-ups\n\n- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 ^t4m1q\n',
      },
    });
    t.ctx.state.markFired('brief:2026-09-25', 'brief');
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    t.notifier.fail = true;

    const failed = await scheduler.tick();
    expect(failed.nudged).toEqual([]);
    expect(failed.errors.length).toBeGreaterThan(0);
    expect(t.ctx.state.wasFired('nudge:t4m1q:2026-09-25')).toBe(false);

    t.notifier.fail = false;
    const retried = await scheduler.tick();
    expect(retried.nudged).toEqual(['t4m1q']);
  });

  it('does nothing when no notifier is configured', async () => {
    t = await makeTestContext({
      now: '2026-09-25T16:00:00Z',
      files: {
        'Tasks/Follow-ups.md':
          '# Follow-ups\n\n- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 ^t4m1q\n',
      },
    });
    t.ctx.state.markFired('brief:2026-09-25', 'brief');
    t.ctx.notifier = null;
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    const report = await scheduler.tick();
    expect(report.nudged).toEqual([]);
    expect(t.ctx.state.wasFired('nudge:t4m1q:2026-09-25')).toBe(false);
  });
});
