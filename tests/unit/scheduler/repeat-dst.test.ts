import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScheduler } from '../../../src/scheduler/scheduler.ts';
import { applyLinkAction } from '../../../src/services/update.ts';
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

/** The single open item currently in Tasks/To do.md, other than `excludeId`. */
function findOpenReminder(t: TestContext, excludeId: string): { id: string; reminder: string } {
  const item = t.ctx.index
    .itemsInNote('Tasks/To do.md')
    .find((i) => i.status === 'open' && i.id !== excludeId && i.reminder !== null);
  if (!item?.id || !item.reminder) throw new Error('no next occurrence found');
  return { id: item.id, reminder: item.reminder };
}

describe('scheduler: repeats', () => {
  it('a completed weekly reminder inserts the next occurrence and fires it next week', async () => {
    t = await makeTestContext({
      now: '2026-09-28T02:00:00Z', // 2026-09-27 19:00 Pacific (PDT, UTC-7)
      files: {
        'Tasks/To do.md':
          '# To do\n\n- [ ] Laundry ⏰ 2026-09-27 19:00 🔁 every week on Sunday ^t2b7m\n',
      },
    });
    t.ctx.state.markFired('brief:2026-09-27', 'brief');
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    const first = await scheduler.tick();
    expect(first.fired).toEqual(['t2b7m']);

    const result = await applyLinkAction(t.ctx, 'done', 't2b7m');
    expect(result.status).toBe('ok');

    const next = findOpenReminder(t, 't2b7m');
    expect(next.reminder).toBe('2026-10-04 19:00');

    t.clock.set('2026-10-05T02:00:00Z'); // 2026-10-04 19:00 Pacific (still PDT)
    t.ctx.state.markFired(`brief:2026-10-04`, 'brief');
    const second = await scheduler.tick();
    expect(second.fired).toEqual([next.id]);
  });
});

describe('scheduler: daylight saving', () => {
  it('a daily 09:00 reminder keeps firing at 09:00 local across the spring-forward boundary', async () => {
    t = await makeTestContext({
      now: '2026-03-07T17:00:00Z', // 2026-03-07 09:00 Pacific (PST, UTC-8)
      files: {
        'Tasks/To do.md':
          '# To do\n\n- [ ] Morning stretch ⏰ 2026-03-07 09:00 🔁 every day ^t0001\n',
      },
    });
    t.ctx.state.markFired('brief:2026-03-07', 'brief');
    t.ctx.state.markFired('brief:2026-03-08', 'brief');
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    const first = await scheduler.tick();
    expect(first.fired).toEqual(['t0001']);

    await applyLinkAction(t.ctx, 'done', 't0001');
    const next = findOpenReminder(t, 't0001');
    expect(next.reminder).toBe('2026-03-08 09:00'); // still 09:00 local, after the US spring-forward

    // Not yet 09:00 local on the far side of the DST boundary (08:59 PDT = 15:59 UTC).
    t.clock.set('2026-03-08T15:59:00Z');
    const early = await scheduler.tick();
    expect(early.fired).toEqual([]);

    // 09:00 PDT = 16:00 UTC.
    t.clock.set('2026-03-08T16:00:00Z');
    const report = await scheduler.tick();
    expect(report.fired).toEqual([next.id]);
  });

  it('a daily 09:00 reminder keeps firing at 09:00 local across the fall-back boundary', async () => {
    t = await makeTestContext({
      now: '2026-10-31T16:00:00Z', // 2026-10-31 09:00 Pacific (PDT, UTC-7)
      files: {
        'Tasks/To do.md':
          '# To do\n\n- [ ] Morning stretch ⏰ 2026-10-31 09:00 🔁 every day ^t0001\n',
      },
    });
    t.ctx.state.markFired('brief:2026-10-31', 'brief');
    t.ctx.state.markFired('brief:2026-11-01', 'brief');
    const scheduler = createScheduler(t.ctx, { backupsDir: await makeBackupsDir() });

    const first = await scheduler.tick();
    expect(first.fired).toEqual(['t0001']);

    await applyLinkAction(t.ctx, 'done', 't0001');
    const next = findOpenReminder(t, 't0001');
    expect(next.reminder).toBe('2026-11-01 09:00'); // still 09:00 local, after the US fall-back

    // Not yet 09:00 local on the far side of the DST boundary (08:59 PST = 16:59 UTC).
    t.clock.set('2026-11-01T16:59:00Z');
    const early = await scheduler.tick();
    expect(early.fired).toEqual([]);

    // 09:00 PST = 17:00 UTC.
    t.clock.set('2026-11-01T17:00:00Z');
    const report = await scheduler.tick();
    expect(report.fired).toEqual([next.id]);
  });
});
