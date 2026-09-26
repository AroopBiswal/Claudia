import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScheduler } from '../../../src/scheduler/scheduler.ts';
import type { Notifier, PushMessage } from '../../../src/notify/ntfy.ts';
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

/** Sends every push, but reports failure for ones matching `failTitle` (so they stay "due"). */
function selectiveNotifier(sent: PushMessage[], failTitle: string): Notifier {
  return {
    send(msg: PushMessage) {
      sent.push(msg);
      if (msg.title === failTitle) {
        return Promise.resolve({ ok: false, error: 'simulated failure' });
      }
      return Promise.resolve({ ok: true, id: `m${sent.length}` });
    },
  };
}

describe('scheduler: brief fallback', () => {
  it('fires at 09:00 (07:30 + 90 minutes) when no brief has been published', async () => {
    t = await makeTestContext({ now: '2026-09-26T15:59:00Z' }); // 08:59 Pacific
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    const early = await scheduler.tick();
    expect(early.fallback).toBe(false);
    expect(t.notifier.sent.filter((m) => m.title === 'Claudia brief')).toHaveLength(0);

    t.clock.set('2026-09-26T16:00:00Z'); // 09:00 Pacific
    const report = await scheduler.tick();
    expect(report.fallback).toBe(true);
    const pushes = t.notifier.sent.filter((m) => m.title === 'Claudia brief');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.message).toBe('Nothing scheduled today.');
    expect(t.ctx.state.wasFired('fallback:2026-09-26')).toBe(true);
  });

  it('does not fire when the brief was already published', async () => {
    t = await makeTestContext({ now: '2026-09-26T16:00:00Z' }); // 09:00 Pacific
    t.ctx.state.markFired('brief:2026-09-26', 'brief');
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    const report = await scheduler.tick();
    expect(report.fallback).toBe(false);
    expect(t.notifier.sent.filter((m) => m.title === 'Claudia brief')).toHaveLength(0);
  });

  it('does not fire once the 6-hour window has passed', async () => {
    // 09:00 + 6h = 15:00 Pacific; one minute past that is out of the window.
    t = await makeTestContext({ now: '2026-09-26T22:01:00Z' });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    const report = await scheduler.tick();
    expect(report.fallback).toBe(false);
    expect(t.notifier.sent.filter((m) => m.title === 'Claudia brief')).toHaveLength(0);
  });

  it('fires only once', async () => {
    t = await makeTestContext({ now: '2026-09-26T16:00:00Z' });
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    await scheduler.tick();
    expect(t.notifier.sent.filter((m) => m.title === 'Claudia brief')).toHaveLength(1);

    const again = await scheduler.tick();
    expect(again.fallback).toBe(false);
    expect(t.notifier.sent.filter((m) => m.title === 'Claudia brief')).toHaveLength(1);
  });

  it('summarizes counts in the message', async () => {
    const files = {
      'Tasks/To do.md': [
        '# To do',
        '',
        '- [ ] Reminder A ⏰ 2026-09-26 12:00 ^t0001',
        '- [ ] Reminder B ⏰ 2026-09-26 15:00 ^t0002',
        '- [ ] Overdue reminder ⏰ 2026-09-25 09:00 ^t0003',
        '',
      ].join('\n'),
      'Tasks/Appointments.md':
        '# Appointments\n\n- [ ] Dentist cleaning #appointment 🗓️ 2026-09-26 15:00-16:00 ^a0001\n',
      'Tasks/Follow-ups.md': [
        '# Follow-ups',
        '',
        '- [ ] Waiting on [[Alex]]: resume draft #waiting 📅 2026-09-26 ➕ 2026-09-01 ^t4m1q',
        '- [ ] Send [[Alex]] the doc #promised 📅 2026-09-26 ➕ 2026-09-01 ^t4m2w',
        '',
      ].join('\n'),
    };
    t = await makeTestContext({ now: '2026-09-26T16:00:00Z', files }); // 09:00 Pacific

    const sent: PushMessage[] = [];
    // Nudges fire in the same tick, before the fallback message is built; make
    // them fail so both follow-ups are still "due for a nudge" in the count.
    t.ctx.notifier = selectiveNotifier(sent, 'Follow-up');

    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });
    const report = await scheduler.tick();
    expect(report.fallback).toBe(true);

    const brief = sent.find((m) => m.title === 'Claudia brief');
    expect(brief?.message).toBe(
      'Today: 1 appointment, 2 reminders, 1 overdue, 2 follow-ups to nudge.',
    );
  });
});
