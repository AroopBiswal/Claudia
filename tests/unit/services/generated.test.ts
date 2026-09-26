import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGeneratedRefresher,
  refreshGenerated,
  renderRecent,
  renderToday,
} from '../../../src/services/generated.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

// Fixed clock: 2026-09-26 10:00 Pacific (Saturday), the default test-context clock.
const FILES = {
  'Tasks/To do.md': [
    '# To do',
    '',
    '- [ ] Call the dentist to reschedule ⏰ 2026-09-26 09:00 ^t9x2k',
    '- [ ] Renew passport 📅 2026-09-26 ^t8c1d',
    '- [ ] Pay rent 📅 2026-09-25 ^tovrd1',
    '',
  ].join('\n'),
  'Tasks/Follow-ups.md': [
    '# Follow-ups',
    '',
    '- [ ] Waiting on Alex: old ask #waiting ➕ 2026-09-20 ^t4m1q',
    '',
  ].join('\n'),
  'Tasks/Appointments.md': [
    '# Appointments',
    '',
    '- [ ] Dentist cleaning at Main St Dental #appointment 🗓️ 2026-09-26 15:00-16:00 ^a3k9p',
    '',
  ].join('\n'),
  'People/Alex.md': [
    '# Alex',
    '',
    '- Staying in Lisbon until mid October ⌛ 2026-09-01 ^f5r8e',
    '',
  ].join('\n'),
};

describe('renderToday', () => {
  it('renders every section exactly, with the effective reminder time and merged follow-ups', () => {
    // 09:00 reminder already passed (now is 10:00) -> also listed under Overdue.
    // Follow-up t4m1q: created 2026-09-20, default 5-day cadence -> nudge on 2026-09-25, already due.
    return makeTestContext({ files: FILES }).then((ctx) => {
      t = ctx;
      const content = renderToday(t.ctx);
      expect(content).toBe(
        [
          '---',
          'claudia: generated',
          '---',
          '> Claudia rewrites this note. Edit the notes it links to instead.',
          '',
          '# Today · Saturday, September 26',
          '',
          '## Brief',
          'No brief yet today.',
          '',
          '## Appointments',
          '- 15:00-16:00 [[Appointments#^a3k9p|Dentist cleaning at Main St Dental #appointment]]',
          '',
          '## Reminders',
          '- 09:00 [[To do#^t9x2k|Call the dentist to reschedule]]',
          '',
          '## Due today',
          '- [[To do#^t8c1d|Renew passport]]',
          '',
          '## Overdue',
          '- ⏰ 2026-09-26 09:00 [[To do#^t9x2k|Call the dentist to reschedule]]',
          '- 📅 2026-09-25 [[To do#^tovrd1|Pay rent]]',
          '',
          '## Follow-ups',
          '- [[Follow-ups#^t4m1q|Waiting on Alex: old ask #waiting]]',
          '',
          '## Stale facts',
          '- [[Alex#^f5r8e|Staying in Lisbon until mid October]] ⌛ 2026-09-01',
          '',
        ].join('\n'),
      );
    });
  });

  it('uses the last notify today_summary as the Brief section', async () => {
    t = await makeTestContext({ files: FILES });
    t.ctx.state.setKv('today-summary:2026-09-26', 'Three things today; dentist at 3pm.');
    const content = renderToday(t.ctx);
    expect(content).toContain('## Brief\nThree things today; dentist at 3pm.\n\n## Appointments');
  });

  it('shows "Nothing." for every empty section', async () => {
    t = await makeTestContext({ files: {} });
    const content = renderToday(t.ctx);
    expect(content).toBe(
      [
        '---',
        'claudia: generated',
        '---',
        '> Claudia rewrites this note. Edit the notes it links to instead.',
        '',
        '# Today · Saturday, September 26',
        '',
        '## Brief',
        'No brief yet today.',
        '',
        '## Appointments',
        '- Nothing.',
        '',
        '## Reminders',
        '- Nothing.',
        '',
        '## Due today',
        '- Nothing.',
        '',
        '## Overdue',
        '- Nothing.',
        '',
        '## Follow-ups',
        '- Nothing.',
        '',
        '## Stale facts',
        '- Nothing.',
        '',
      ].join('\n'),
    );
  });

  it('does not double-count a follow-up that is both nudge-due and merged once', async () => {
    t = await makeTestContext({
      files: {
        'Tasks/Follow-ups.md': [
          '# Follow-ups',
          '',
          '- [ ] Waiting on Alex: old ask #waiting ➕ 2026-09-20 📅 2026-09-26 ^t4m1q',
          '',
        ].join('\n'),
      },
    });
    const content = renderToday(t.ctx);
    const occurrences = content.split('t4m1q').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('renderRecent', () => {
  it('groups captures by day, newest first, with details and surface', async () => {
    t = await makeTestContext({
      files: {
        'Log/2026-09-26.md': [
          '# Log 2026-09-26',
          '',
          '- 09:14 · iPhone chat · added [[To do#^t9x2k|Call the dentist to reschedule]] ⏰ Tue 9:00am',
          '',
        ].join('\n'),
      },
    });
    const content = await renderRecent(t.ctx);
    expect(content).toBe(
      [
        '---',
        'claudia: generated',
        '---',
        '> Claudia rewrites this note. Edit the notes it links to instead.',
        '',
        '# Recently captured',
        '',
        '## Saturday, September 26',
        '- 09:14 · [[To do#^t9x2k|Call the dentist to reschedule]] ⏰ Tue 9:00am · iPhone chat',
        '',
      ].join('\n'),
    );
  });

  it('shows the empty-state line when nothing was captured', async () => {
    t = await makeTestContext({ files: {} });
    const content = await renderRecent(t.ctx);
    expect(content).toBe(
      [
        '---',
        'claudia: generated',
        '---',
        '> Claudia rewrites this note. Edit the notes it links to instead.',
        '',
        '# Recently captured',
        '',
        '- Nothing captured in the last 7 days.',
        '',
      ].join('\n'),
    );
  });

  it('groups multiple days with a blank line between day headings', async () => {
    t = await makeTestContext({
      files: {
        'Log/2026-09-26.md': [
          '# Log 2026-09-26',
          '',
          '- 09:00 · web chat · added [[To do#^t0001|Water plants]]',
          '',
        ].join('\n'),
        'Log/2026-09-25.md': [
          '# Log 2026-09-25',
          '',
          '- 20:00 · web chat · added [[To do#^t0002|Buy milk]]',
          '',
        ].join('\n'),
      },
    });
    const content = await renderRecent(t.ctx);
    expect(content).toContain(
      [
        '## Saturday, September 26',
        '- 09:00 · [[To do#^t0001|Water plants]] · web chat',
        '',
        '## Friday, September 25',
        '- 20:00 · [[To do#^t0002|Buy milk]] · web chat',
      ].join('\n'),
    );
  });
});

describe('refreshGenerated', () => {
  it('writes both notes and reports whether each changed', async () => {
    t = await makeTestContext({ files: FILES });
    const first = await refreshGenerated(t.ctx);
    expect(first).toEqual({ today: true, recent: true });

    const today = await t.ctx.writer.read('Today.md');
    expect(today).toBe(renderToday(t.ctx));
    const recent = await t.ctx.writer.read('Recently captured.md');
    expect(recent).toBe(await renderRecent(t.ctx));

    // Nothing changed: a second refresh is a no-op write.
    const second = await refreshGenerated(t.ctx);
    expect(second).toEqual({ today: false, recent: false });

    // refreshGenerated must not trigger afterWrite/onVaultChanged itself.
    expect(t.changes).toBe(0);
  });
});

describe('createGeneratedRefresher', () => {
  function fakeTimerHarness() {
    let queued: { fn: () => void; ms: number } | null = null;
    const setTimer = vi.fn((fn: () => void, ms: number) => {
      queued = { fn, ms };
      return {};
    });
    const clearTimer = vi.fn(() => {
      queued = null;
    });
    return {
      setTimer,
      clearTimer,
      fire(): void {
        const q = queued;
        queued = null;
        q?.fn();
      },
      get pendingMs(): number | null {
        return queued?.ms ?? null;
      },
    };
  }

  it('debounces: a burst of schedule() calls only refreshes once, after the timer fires', async () => {
    t = await makeTestContext({ files: FILES });
    const timers = fakeTimerHarness();
    const refresher = createGeneratedRefresher(t.ctx, {
      debounceMs: 2000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    refresher.schedule();
    refresher.schedule();
    refresher.schedule();

    expect(timers.setTimer).toHaveBeenCalledTimes(3);
    expect(timers.clearTimer).toHaveBeenCalledTimes(2); // cancels the first two pending timers
    expect(timers.pendingMs).toBe(2000);

    expect(await t.ctx.writer.read('Today.md')).toBeNull();
    timers.fire();
    await refresher.flush(); // wait for the in-flight refresh triggered by fire()

    expect(await t.ctx.writer.read('Today.md')).not.toBeNull();
  });

  it('flush() runs a pending scheduled refresh immediately', async () => {
    t = await makeTestContext({ files: FILES });
    const timers = fakeTimerHarness();
    const refresher = createGeneratedRefresher(t.ctx, {
      debounceMs: 2000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    refresher.schedule();
    await refresher.flush();

    expect(timers.clearTimer).toHaveBeenCalled();
    expect(await t.ctx.writer.read('Today.md')).not.toBeNull();
  });

  it('flush() is a no-op when nothing is scheduled or in flight', async () => {
    t = await makeTestContext({ files: FILES });
    const timers = fakeTimerHarness();
    const refresher = createGeneratedRefresher(t.ctx, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await expect(refresher.flush()).resolves.toBeUndefined();
    expect(await t.ctx.writer.read('Today.md')).toBeNull();
  });

  it('stop() cancels a pending refresh without running it', async () => {
    t = await makeTestContext({ files: FILES });
    const timers = fakeTimerHarness();
    const refresher = createGeneratedRefresher(t.ctx, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    refresher.schedule();
    refresher.stop();
    expect(timers.clearTimer).toHaveBeenCalledTimes(1);
    expect(timers.pendingMs).toBeNull();
  });
});
