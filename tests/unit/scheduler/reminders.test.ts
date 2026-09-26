import { mkdtemp, rm } from 'node:fs/promises';
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

/**
 * These tests only care about reminder firing, so the morning brief fallback
 * (also due most of the day by default: 07:30 + 90 minutes) is pre-marked as
 * published, keeping it out of notifier.sent.
 */
async function makeReminderTestContext(
  opts: Parameters<typeof makeTestContext>[0],
): Promise<TestContext> {
  const context = await makeTestContext(opts);
  context.ctx.state.markFired('brief:2026-09-26', 'brief');
  context.ctx.state.markFired('brief:2026-09-27', 'brief');
  return context;
}

describe('scheduler: reminders', () => {
  it('fires exactly at its time, once', async () => {
    t = await makeReminderTestContext({
      now: '2026-09-26T17:00:00Z', // 2026-09-26 10:00 Pacific
      files: {
        'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-26 10:00 ^t0001\n',
      },
    });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    const report = await scheduler.tick();
    expect(report.fired).toEqual(['t0001']);
    expect(t.notifier.sent).toHaveLength(1);
    expect(t.notifier.sent[0]?.title).toBe('Reminder');
    expect(t.ctx.state.wasFired('reminder:t0001:2026-09-26 10:00')).toBe(true);

    const again = await scheduler.tick();
    expect(again.fired).toEqual([]);
    expect(t.notifier.sent).toHaveLength(1);
  });

  it('does not fire a minute before its time', async () => {
    t = await makeReminderTestContext({
      now: '2026-09-26T16:59:00Z', // 09:59 Pacific
      files: {
        'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-26 10:00 ^t0001\n',
      },
    });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    const report = await scheduler.tick();
    expect(report.fired).toEqual([]);
    expect(t.notifier.sent).toHaveLength(0);
  });

  it('re-fires at a new time after ⏰ is edited in the vault', async () => {
    t = await makeReminderTestContext({
      now: '2026-09-26T17:00:00Z',
      files: {
        'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-26 10:00 ^t0001\n',
      },
    });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    await scheduler.tick();
    expect(t.notifier.sent).toHaveLength(1);

    await t.vault.write(
      'Tasks/To do.md',
      '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-26 11:00 ^t0001\n',
    );
    await t.ctx.index.reindexFile('Tasks/To do.md');

    t.clock.set('2026-09-26T17:30:00Z'); // 10:30, before the new time
    const notYet = await scheduler.tick();
    expect(notYet.fired).toEqual([]);
    expect(t.notifier.sent).toHaveLength(1);

    t.clock.set('2026-09-26T18:00:00Z'); // 11:00
    const refired = await scheduler.tick();
    expect(refired.fired).toEqual(['t0001']);
    expect(t.notifier.sent).toHaveLength(2);
  });

  it('fires at 💤 when snoozed past ⏰', async () => {
    t = await makeReminderTestContext({
      now: '2026-09-26T17:00:00Z',
      files: {
        'Tasks/To do.md':
          '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-26 09:00 💤 2026-09-26 11:00 ^t0001\n',
      },
    });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    const early = await scheduler.tick();
    expect(early.fired).toEqual([]);

    t.clock.set('2026-09-26T18:00:00Z'); // 11:00
    const report = await scheduler.tick();
    expect(report.fired).toEqual(['t0001']);
  });

  it('never fires a done item', async () => {
    t = await makeReminderTestContext({
      now: '2026-09-26T17:00:00Z',
      files: {
        'Tasks/To do.md':
          '# To do\n\n- [x] Call the dentist ⏰ 2026-09-26 10:00 ✅ 2026-09-26 ^t0001\n',
      },
    });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    const report = await scheduler.tick();
    expect(report.fired).toEqual([]);
    expect(t.notifier.sent).toHaveLength(0);
  });

  it('fires a follow-up that carries ⏰', async () => {
    t = await makeReminderTestContext({
      now: '2026-09-26T17:00:00Z',
      files: {
        'Tasks/Follow-ups.md':
          '# Follow-ups\n\n- [ ] Waiting on [[Alex]]: reply #waiting ⏰ 2026-09-26 10:00 ➕ 2026-09-01 ^t0002\n',
      },
    });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    const report = await scheduler.tick();
    expect(report.fired).toEqual(['t0002']);
  });

  it('never pushes for an appointment line', async () => {
    t = await makeReminderTestContext({
      now: '2026-09-26T17:00:00Z',
      files: {
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Dentist cleaning #appointment 🗓️ 2026-09-26 10:00-11:00 ^a0001\n',
      },
    });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    const report = await scheduler.tick();
    expect(report.fired).toEqual([]);
    expect(report.bundled).toEqual([]);
    expect(t.notifier.sent).toHaveLength(0);
  });

  it('downtime catch-up: recent misses fire individually (late), older ones bundle, once', async () => {
    t = await makeReminderTestContext({
      now: '2026-09-26T17:00:00Z', // 10:00 Pacific
      files: {
        'Tasks/To do.md': [
          '# To do',
          '',
          '- [ ] Thirty minutes ago ⏰ 2026-09-26 09:30 ^t0030',
          '- [ ] Ninety minutes ago ⏰ 2026-09-26 08:30 ^t0090',
          '- [ ] Three hours ago ⏰ 2026-09-26 07:00 ^t0300',
          '- [ ] A day ago ⏰ 2026-09-25 08:00 ^t2600',
          '',
        ].join('\n'),
      },
    });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    const report = await scheduler.tick();

    expect(report.fired.slice().sort()).toEqual(['t0030', 't0090']);
    expect(report.bundled.slice().sort()).toEqual(['t0300', 't2600']);

    const individualPushes = t.notifier.sent.filter((m) => m.title?.startsWith('Reminder'));
    expect(individualPushes).toHaveLength(2);
    expect(individualPushes.every((m) => m.title === 'Reminder (late)')).toBe(true);

    const bundlePushes = t.notifier.sent.filter((m) => m.title === 'While I was offline');
    expect(bundlePushes).toHaveLength(1);
    expect(bundlePushes[0]?.message).toContain('Three hours ago');
    expect(bundlePushes[0]?.message).toContain('A day ago');

    expect(t.ctx.state.wasFired('reminder:t0030:2026-09-26 09:30')).toBe(true);
    expect(t.ctx.state.wasFired('reminder:t0090:2026-09-26 08:30')).toBe(true);
    expect(t.ctx.state.wasFired('reminder:t0300:2026-09-26 07:00')).toBe(true);
    expect(t.ctx.state.wasFired('reminder:t2600:2026-09-25 08:00')).toBe(true);

    const again = await scheduler.tick();
    expect(again.fired).toEqual([]);
    expect(again.bundled).toEqual([]);
    expect(t.notifier.sent).toHaveLength(3);
  });

  it('bundles more than 15 stale reminders with an "and N more" line', async () => {
    const lines = ['# To do', ''];
    for (let i = 0; i < 18; i++) {
      const id = `t1${String(i).padStart(3, '0')}`;
      lines.push(`- [ ] Stale reminder ${i} ⏰ 2026-09-20 08:00 ^${id}`);
    }
    t = await makeReminderTestContext({
      now: '2026-09-26T17:00:00Z',
      files: { 'Tasks/To do.md': lines.join('\n') + '\n' },
    });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    const report = await scheduler.tick();

    expect(report.bundled).toHaveLength(18);
    const bundlePushes = t.notifier.sent.filter((m) => m.title === 'While I was offline');
    expect(bundlePushes).toHaveLength(1);
    expect(bundlePushes[0]?.message).toContain('and 3 more.');
  });

  it('retries a failed send on the next tick without marking it fired', async () => {
    t = await makeReminderTestContext({
      now: '2026-09-26T17:00:00Z',
      files: {
        'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-26 10:00 ^t0001\n',
      },
    });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    t.notifier.fail = true;

    const failed = await scheduler.tick();
    expect(failed.fired).toEqual([]);
    expect(failed.errors.length).toBeGreaterThan(0);
    expect(t.ctx.state.wasFired('reminder:t0001:2026-09-26 10:00')).toBe(false);

    t.notifier.fail = false;
    const retried = await scheduler.tick();
    expect(retried.fired).toEqual(['t0001']);
  });

  it('does nothing and records one error when no notifier is configured', async () => {
    t = await makeReminderTestContext({
      now: '2026-09-26T17:00:00Z',
      files: {
        'Tasks/To do.md':
          '# To do\n\n- [ ] One ⏰ 2026-09-26 10:00 ^t0001\n- [ ] Two ⏰ 2026-09-26 10:00 ^t0002\n',
      },
    });
    t.ctx.notifier = null;
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    const report = await scheduler.tick();
    expect(report.fired).toEqual([]);
    expect(report.bundled).toEqual([]);
    expect(report.errors.filter((e) => e.includes('no notifier'))).toHaveLength(1);
    expect(t.ctx.state.wasFired('reminder:t0001:2026-09-26 10:00')).toBe(false);
    expect(t.ctx.state.wasFired('reminder:t0002:2026-09-26 10:00')).toBe(false);
  });

  it('ticks never overlap: a tick started while one is running returns an empty report', async () => {
    t = await makeReminderTestContext({
      now: '2026-09-26T17:00:00Z',
      files: {
        'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-26 10:00 ^t0001\n',
      },
    });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    const first = scheduler.tick();
    const second = await scheduler.tick();
    expect(second).toEqual({
      fired: [],
      bundled: [],
      nudged: [],
      fallback: false,
      nightly: false,
      dayRolled: false,
      errors: [],
    });
    const firstReport = await first;
    expect(firstReport.fired).toEqual(['t0001']);
  });
});
