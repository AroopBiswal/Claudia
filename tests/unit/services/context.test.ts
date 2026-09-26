import { afterEach, describe, expect, it } from 'vitest';
import { afterWrite, nowLabel, todayOf, zoneOf } from '../../../src/services/context.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

describe('service context', () => {
  it('reads zone and dates from the vault settings', async () => {
    t = await makeTestContext();
    expect(zoneOf(t.ctx)).toBe('America/Los_Angeles');
    expect(todayOf(t.ctx)).toBe('2026-09-26');
    expect(nowLabel(t.ctx)).toBe('2026-09-26 10:00 Sat');
  });

  it('afterWrite reindexes written notes and signals a change', async () => {
    t = await makeTestContext();
    await t.ctx.writer.append('Tasks/To do.md', ['- [ ] Water plants ⏰ 2026-09-27 18:00 ^t0001']);
    expect(t.ctx.index.getItem('t0001')).toBeNull();
    await afterWrite(t.ctx, ['Tasks/To do.md']);
    expect(t.ctx.index.getItem('t0001')?.reminder).toBe('2026-09-27 18:00');
    expect(t.changes).toBe(1);
  });
});
