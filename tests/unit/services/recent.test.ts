import { afterEach, describe, expect, it } from 'vitest';
import { recentCaptures } from '../../../src/services/recent.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

describe('recentCaptures', () => {
  it('parses an added line with details and quoted source words', async () => {
    t = await makeTestContext({
      files: {
        'Log/2026-09-26.md': [
          '# Log 2026-09-26',
          '',
          '- 09:14 · iPhone chat · added [[To do#^t9x2k|Call the dentist]] ⏰ Tue 9:00am · "remind me to call the dentist tuesday morning"',
          '',
        ].join('\n'),
      },
    });
    const captures = await recentCaptures(t.ctx, 1);
    expect(captures).toEqual([
      {
        date: '2026-09-26',
        time: '09:14',
        surface: 'iPhone chat',
        id: 't9x2k',
        text: 'Call the dentist',
        note: 'To do',
        details: '⏰ Tue 9:00am',
        words: 'remind me to call the dentist tuesday morning',
      },
    ]);
  });

  it('parses an added line with no details and no quoted words', async () => {
    t = await makeTestContext({
      files: {
        'Log/2026-09-26.md': [
          '# Log 2026-09-26',
          '',
          '- 08:00 · web chat · added [[Follow-ups#^t4m1q|Waiting on Alex: resume draft]]',
          '',
        ].join('\n'),
      },
    });
    const captures = await recentCaptures(t.ctx, 1);
    expect(captures).toEqual([
      {
        date: '2026-09-26',
        time: '08:00',
        surface: 'web chat',
        id: 't4m1q',
        text: 'Waiting on Alex: resume draft',
        note: 'Follow-ups',
        details: null,
        words: null,
      },
    ]);
  });

  it('parses an added line with a quoted-words segment but no other details', async () => {
    t = await makeTestContext({
      files: {
        'Log/2026-09-26.md': [
          '# Log 2026-09-26',
          '',
          '- 08:00 · voice · added [[To do#^t0001|Water plants]] · "water the plants"',
          '',
        ].join('\n'),
      },
    });
    const captures = await recentCaptures(t.ctx, 1);
    expect(captures[0]?.details).toBeNull();
    expect(captures[0]?.words).toBe('water the plants');
  });

  it('skips non-added verbs and malformed lines, and is newest-first across days', async () => {
    t = await makeTestContext({
      files: {
        'Log/2026-09-26.md': [
          '# Log 2026-09-26',
          '',
          '- 09:20 · push · completed [[To do#^t9x2k|Call the dentist]]',
          '- this is not a log line at all',
          '- 09:14 · iPhone chat · added [[To do#^t9x2k|Call the dentist]]',
          '',
        ].join('\n'),
        'Log/2026-09-25.md': [
          '# Log 2026-09-25',
          '',
          '- 20:00 · web chat · added [[Tasks#^t0002|Buy milk]]',
          '',
        ].join('\n'),
      },
    });
    const captures = await recentCaptures(t.ctx, 2);
    expect(captures.map((c) => c.id)).toEqual(['t9x2k', 't0002']);
    expect(captures.map((c) => `${c.date} ${c.time}`)).toEqual([
      '2026-09-26 09:14',
      '2026-09-25 20:00',
    ]);
  });

  it('returns nothing when there is no Log note for a day, without throwing', async () => {
    t = await makeTestContext({ files: {} });
    const captures = await recentCaptures(t.ctx, 3);
    expect(captures).toEqual([]);
  });

  it('ignores lines inside frontmatter and code fences', async () => {
    t = await makeTestContext({
      files: {
        'Log/2026-09-26.md': [
          '---',
          'claudia: log',
          '---',
          '# Log 2026-09-26',
          '',
          '```',
          '- 09:00 · web chat · added [[To do#^tfake|Fake]]',
          '```',
          '- 10:00 · web chat · added [[To do#^treal|Real]]',
          '',
        ].join('\n'),
      },
    });
    const captures = await recentCaptures(t.ctx, 1);
    expect(captures.map((c) => c.id)).toEqual(['treal']);
  });
});
