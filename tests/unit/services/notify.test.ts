import { afterEach, describe, expect, it } from 'vitest';
import { notify } from '../../../src/services/notify.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

describe('notify', () => {
  it('sends a push with defaults and clicks through to Today.md', async () => {
    t = await makeTestContext();
    const result = await notify(t.ctx, { message: 'Dentist at 3pm.' });
    if ('error' in result) throw new Error('unexpected error');
    expect(result.status).toBe('sent');
    expect(result.today_updated).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(t.notifier.sent).toHaveLength(1);
    expect(t.notifier.sent[0]).toMatchObject({
      title: 'Claudia',
      message: 'Dentist at 3pm.',
      priority: 'default',
      click: 'obsidian://open?vault=Claudia&file=Today.md',
    });
  });

  it('maps a custom title and priority through to the push', async () => {
    t = await makeTestContext();
    await notify(t.ctx, { message: 'Hi', title: 'Custom', priority: 'high' });
    expect(t.notifier.sent[0]).toMatchObject({ title: 'Custom', priority: 'high' });
  });

  it('clicks through to the given item when open_id resolves', async () => {
    t = await makeTestContext({
      files: {
        'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^t9x2k\n',
      },
    });
    const result = await notify(t.ctx, { message: 'Reminder', open_id: 't9x2k' });
    if ('error' in result) throw new Error('unexpected error');
    expect(t.notifier.sent[0]?.click).toBe(
      'obsidian://open?vault=Claudia&file=Tasks%2FTo%20do.md%23%5Et9x2k',
    );
  });

  it('falls back to Today.md when open_id does not resolve', async () => {
    t = await makeTestContext();
    await notify(t.ctx, { message: 'Reminder', open_id: 'nope' });
    expect(t.notifier.sent[0]?.click).toBe('obsidian://open?vault=Claudia&file=Today.md');
  });

  it('reports failed with a reason when the notifier is not configured', async () => {
    t = await makeTestContext();
    t.ctx.notifier = null; // simulate an unconfigured notifier
    const result = await notify(t.ctx, { message: 'Hi' });
    if ('error' in result) throw new Error('unexpected error');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('Push is not configured yet');
  });

  it("reports failed with the notifier's error when sending fails", async () => {
    t = await makeTestContext();
    t.notifier.fail = true;
    const result = await notify(t.ctx, { message: 'Hi' });
    if ('error' in result) throw new Error('unexpected error');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('fake failure');
  });

  it('updates Today.md when today_summary is given', async () => {
    t = await makeTestContext();
    const result = await notify(t.ctx, { message: 'Brief', today_summary: 'Three things today.' });
    if ('error' in result) throw new Error('unexpected error');
    expect(result.today_updated).toBe(true);
    expect(t.ctx.state.getKv('today-summary:2026-09-26')).toBe('Three things today.');
    const today = await t.ctx.writer.read('Today.md');
    expect(today).toContain('Three things today.');
  });

  it('marks the brief as published even when the push fails', async () => {
    t = await makeTestContext();
    t.notifier.fail = true;
    expect(t.ctx.state.wasFired('brief:2026-09-26')).toBe(false);
    const result = await notify(t.ctx, { message: 'Brief', kind: 'brief' });
    if ('error' in result) throw new Error('unexpected error');
    expect(result.status).toBe('failed');
    expect(t.ctx.state.wasFired('brief:2026-09-26')).toBe(true);
  });

  it('does not mark the brief published for a plain message', async () => {
    t = await makeTestContext();
    await notify(t.ctx, { message: 'Hi', kind: 'message' });
    expect(t.ctx.state.wasFired('brief:2026-09-26')).toBe(false);
  });

  it('returns an error-shaped result for invalid input, never throwing', async () => {
    t = await makeTestContext();
    const result = await notify(t.ctx, { message: '' });
    expect('error' in result).toBe(true);

    const badPriority = await notify(t.ctx, { message: 'Hi', priority: 'urgent' });
    expect('error' in badPriority).toBe(true);
  });
});
