import { afterEach, describe, expect, it } from 'vitest';
import { findSimilar, jaccard, normalizedWords } from '../../../src/services/duplicates.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

describe('normalizedWords / jaccard', () => {
  it('lowercases, strips punctuation and drops stop words', () => {
    expect(normalizedWords('Call the Dentist, for a Cleaning!')).toEqual(
      new Set(['call', 'dentist', 'cleaning']),
    );
  });

  it('scores identical word sets as 1', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('scores disjoint sets as 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('scores partial overlap by intersection over union', () => {
    // {call, dentist} vs {call, dentist, cleaning}: intersection 2, union 3.
    expect(
      jaccard(new Set(['call', 'dentist']), new Set(['call', 'dentist', 'cleaning'])),
    ).toBeCloseTo(2 / 3);
  });
});

describe('findSimilar', () => {
  it('finds an open task at or above the similar threshold, best first', async () => {
    t = await makeTestContext({
      files: {
        'Tasks/To do.md':
          '# To do\n\n- [ ] Call the dentist to reschedule ^t0001\n- [ ] Buy stamps ^t0002\n',
      },
    });

    const matches = findSimilar(t.ctx, 'task', 'Call the dentist to reschedule the cleaning');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.item.id).toBe('t0001');
    expect(matches[0]!.score).toBeGreaterThanOrEqual(0.5);
  });

  it('excludes done items', async () => {
    t = await makeTestContext({
      files: {
        'Tasks/To do.md': '# To do\n\n- [x] Call the dentist ✅ 2026-09-01 ^t0001\n',
      },
    });
    const matches = findSimilar(t.ctx, 'task', 'Call the dentist');
    expect(matches).toEqual([]);
  });

  it('excludes items of a different kind', async () => {
    t = await makeTestContext({
      files: {
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Call the dentist #appointment 🗓️ 2026-10-01 09:00-10:00 ^a0001\n',
      },
    });
    const matches = findSimilar(t.ctx, 'task', 'Call the dentist');
    expect(matches).toEqual([]);
  });

  it('returns nothing below the similar threshold', async () => {
    t = await makeTestContext({
      files: {
        'Tasks/To do.md': '# To do\n\n- [ ] Buy stamps ^t0001\n',
      },
    });
    const matches = findSimilar(t.ctx, 'task', 'Call the dentist to reschedule');
    expect(matches).toEqual([]);
  });
});
