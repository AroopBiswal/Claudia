import { afterEach, describe, expect, it } from 'vitest';
import { appendLog, formatLogLine } from '../../../src/services/log.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

describe('formatLogLine', () => {
  it('renders a full added line: surface, link, details and quoted words', () => {
    const line = formatLogLine(
      {
        surface: 'iPhone chat',
        verb: 'added',
        path: 'Tasks/To do.md',
        id: 't9x2k',
        text: 'Call the dentist to reschedule',
        details: ' ⏰ Tue 9:00am',
        words: 'remind me to call the dentist tuesday morning',
      },
      '09:14',
    );
    expect(line).toBe(
      '- 09:14 · iPhone chat · added [[To do#^t9x2k|Call the dentist to reschedule]] ⏰ Tue 9:00am · "remind me to call the dentist tuesday morning"',
    );
  });

  it('renders a bare push completion with no details or words', () => {
    const line = formatLogLine(
      {
        surface: 'push',
        verb: 'completed',
        path: 'Tasks/To do.md',
        id: 't9x2k',
        text: 'Call the dentist to reschedule',
      },
      '09:20',
    );
    expect(line).toBe('- 09:20 · push · completed [[To do#^t9x2k|Call the dentist to reschedule]]');
  });

  it('renders "Claudia" for a null surface', () => {
    const line = formatLogLine(
      { surface: null, verb: 'archived', path: 'Tasks/Done/2026-09.md' },
      '00:05',
    );
    expect(line).toBe('- 00:05 · Claudia · archived [[2026-09]]');
  });

  it('replaces " · " inside a surface with " - "', () => {
    const line = formatLogLine(
      { surface: 'Cowork · web', verb: 'changed setting', details: ' Brief time: 08:00' },
      '08:00',
    );
    expect(line).toBe('- 08:00 · Cowork - web · changed setting Brief time: 08:00');
  });

  it('collapses newlines, swaps quotes, and truncates words to 200 chars with an ellipsis', () => {
    const long = 'a'.repeat(210);
    const line = formatLogLine(
      { surface: null, verb: 'added', words: `line one\nline "two"\r\nline three ${long}` },
      '10:00',
    );
    const wordsPart = line.slice(line.indexOf('"'));
    // Opening quote + up to 200 chars + closing quote.
    expect(wordsPart.startsWith("\"line one line 'two' line three ")).toBe(true);
    expect(wordsPart.endsWith('…"')).toBe(true);
    expect(wordsPart.length).toBe(202);
  });

  it('omits the link entirely when there is no path', () => {
    const line = formatLogLine({ surface: 'push', verb: 'undid', details: ' (2 items)' }, '11:00');
    expect(line).toBe('- 11:00 · push · undid (2 items)');
  });
});

describe('appendLog', () => {
  it('creates Log/<today>.md with the seeded header and appends a line', async () => {
    t = await makeTestContext();
    await appendLog(t.ctx, {
      surface: 'iPhone chat',
      verb: 'added',
      path: 'Tasks/To do.md',
      id: 't9x2k',
      text: 'Call the dentist',
      details: ' ⏰ Tue 9:00am',
      words: 'remind me to call the dentist tuesday morning',
    });

    const text = await t.ctx.writer.read('Log/2026-09-26.md');
    expect(text).toBe(
      '# Log 2026-09-26\n\n' +
        '- 10:00 · iPhone chat · added [[To do#^t9x2k|Call the dentist]] ⏰ Tue 9:00am · "remind me to call the dentist tuesday morning"\n',
    );
  });

  it('appends a second line below the first on the same day', async () => {
    t = await makeTestContext();
    await appendLog(t.ctx, {
      surface: 'push',
      verb: 'added',
      path: 'Tasks/To do.md',
      id: 't1',
      text: 'One',
    });
    t.clock.advanceMinutes(5);
    await appendLog(t.ctx, {
      surface: 'push',
      verb: 'completed',
      path: 'Tasks/To do.md',
      id: 't1',
      text: 'One',
    });

    const text = await t.ctx.writer.read('Log/2026-09-26.md');
    expect(text).toBe(
      '# Log 2026-09-26\n\n' +
        '- 10:00 · push · added [[To do#^t1|One]]\n' +
        '- 10:05 · push · completed [[To do#^t1|One]]\n',
    );
  });
});
