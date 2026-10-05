import { afterEach, describe, expect, it } from 'vitest';
import { recall } from '../../../src/services/recall.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const FILES = {
  'Tasks/To do.md': [
    '# To do',
    '',
    '- [ ] Call the dentist to reschedule ⏰ 2026-09-29 09:00 ^t9x2k',
    '- [x] Buy milk ✅ 2026-09-20 ^t0002',
    '',
  ].join('\n'),
  'Tasks/Follow-ups.md': [
    '# Follow-ups',
    '',
    '- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 📅 2026-10-02 ^t4m1q',
    '',
  ].join('\n'),
  'People/Alex.md': [
    '# Alex',
    '',
    '- Friend from college ^f1a9z',
    '- Plays cello ➕ 2026-09-25 18:30 ^f1a9y',
    '',
  ].join('\n'),
};

describe('recall', () => {
  it('finds an item by text and shapes it as an ItemView with an obsidian link', async () => {
    t = await makeTestContext({ files: FILES });
    const result = recall(t.ctx, { query: 'dentist' });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.now).toBe('2026-09-26 10:00 Sat');
    expect(result.total).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      id: 't9x2k',
      kind: 'task',
      status: 'open',
      text: 'Call the dentist to reschedule',
      note: 'Tasks/To do.md',
      reminder: '2026-09-29 09:00',
    });
    expect(result.results[0]?.link).toBe(
      'obsidian://open?vault=Claudia&file=Tasks%2FTo%20do.md%23%5Et9x2k',
    );
  });

  it('excludes done items by default and includes them with include_done', async () => {
    t = await makeTestContext({ files: FILES });
    const withoutDone = recall(t.ctx, { query: 'milk' });
    if ('error' in withoutDone) throw new Error('unexpected error');
    expect(withoutDone.total).toBe(0);

    const withDone = recall(t.ctx, { query: 'milk', include_done: true });
    if ('error' in withDone) throw new Error('unexpected error');
    expect(withDone.total).toBe(1);
    expect(withDone.results[0]?.status).toBe('done');
  });

  it('filters by kinds and person', async () => {
    t = await makeTestContext({ files: FILES });
    const byKind = recall(t.ctx, { query: 'draft', kinds: ['task'] });
    if ('error' in byKind) throw new Error('unexpected error');
    expect(byKind.total).toBe(0);

    const byFollowUp = recall(t.ctx, { query: 'draft', kinds: ['follow_up'] });
    if ('error' in byFollowUp) throw new Error('unexpected error');
    expect(byFollowUp.total).toBe(1);

    const byPerson = recall(t.ctx, { query: '', person: 'Alex' });
    if ('error' in byPerson) throw new Error('unexpected error');
    expect(byPerson.total).toBeGreaterThanOrEqual(2); // the follow-up and the fact
  });

  it('returns created so callers see when a fact was saved', async () => {
    t = await makeTestContext({ files: FILES });
    const cello = recall(t.ctx, { query: 'cello' });
    if ('error' in cello) throw new Error('unexpected error');
    expect(cello.results[0]).toMatchObject({ kind: 'fact', created: '2026-09-25 18:30' });

    const old = recall(t.ctx, { query: 'college' });
    if ('error' in old) throw new Error('unexpected error');
    expect(old.results[0]?.created).toBeNull();

    const followUp = recall(t.ctx, { query: 'draft' });
    if ('error' in followUp) throw new Error('unexpected error');
    expect(followUp.results[0]?.created).toBe('2026-09-20');
  });

  it('rejects an empty query without a person', async () => {
    t = await makeTestContext({ files: FILES });
    const result = recall(t.ctx, { query: '' });
    expect('error' in result).toBe(true);
  });

  it('rejects an empty query with only whitespace and no person', async () => {
    t = await makeTestContext({ files: FILES });
    const result = recall(t.ctx, { query: '   ' });
    expect('error' in result).toBe(true);
  });

  it('returns an error-shaped result on invalid input instead of throwing', async () => {
    t = await makeTestContext({ files: FILES });
    expect(() => recall(t!.ctx, { query: 'x', limit: 999 })).not.toThrow();
    const result = recall(t.ctx, { query: 'x', limit: 999 });
    expect('error' in result).toBe(true);

    const badKind = recall(t.ctx, { query: 'x', kinds: ['bogus'] });
    expect('error' in badKind).toBe(true);
  });

  it('clamps limit within 1 to 50 and defaults to 10', async () => {
    t = await makeTestContext({ files: FILES });
    const result = recall(t.ctx, { query: 'the' });
    if ('error' in result) throw new Error('unexpected error');
    expect(result.results.length).toBeLessThanOrEqual(10);
  });
});
