import { afterEach, describe, expect, it } from 'vitest';
import { agenda, renderAgendaText } from '../../../src/services/agenda.ts';
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
    '- [ ] Call the dentist ⏰ 2026-09-26 09:00 ^t0001',
    '- [ ] Morning stretch ⏰ 2026-09-27 08:00 ^t0002',
    '- [ ] Submit report 📅 2026-09-26 ^t0003',
    '- [ ] Pay rent 📅 2026-09-25 ^t0004',
    '- [ ] Plan trip 📅 2026-09-29 ^t0005',
    '- [ ] Weird repeat 🔁 every blue moon ^t0006',
    '- [ ] Daily stretch 🔁 every day ^t0007',
    '- [x] Buy milk ✅ 2026-09-20 ^t0008',
    '',
  ].join('\n'),
  'Tasks/Follow-ups.md': [
    '# Follow-ups',
    '',
    '- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-26 ^t1001',
    '- [ ] Send [[Alex]] the referral link #promised ➕ 2026-09-26 📅 2026-10-05 ^t1002',
    '- [ ] Waiting on [[Alex]]: old ask #waiting ➕ 2026-09-20 ^t1003',
    '',
  ].join('\n'),
  'Tasks/Appointments.md': [
    '# Appointments',
    '',
    '- [ ] Dentist cleaning at Main St Dental #appointment 🗓️ 2026-09-26 15:00-16:00 ^a3001',
    '- [ ] Conference #appointment 🗓️ 2026-09-29 10:00-11:00 ^a3002',
    '',
  ].join('\n'),
  'People/Alex.md': [
    '# Alex',
    '',
    '- Friend from college ^f2001',
    '- Staying in Lisbon until mid October ⌛ 2026-09-01 ^f2002',
    '- Loves hiking ⌛ 2026-12-01 ^f2003',
    '',
  ].join('\n'),
};

function ids(items: { id: string | null }[]): (string | null)[] {
  return items.map((i) => i.id);
}

describe('agenda: today', () => {
  it("lists today's appointments, reminders and due items", async () => {
    t = await makeTestContext({ files: FILES });
    const result = await agenda(t.ctx, { view: 'today' });
    if ('error' in result) throw new Error('unexpected error');
    if (result.view !== 'today') throw new Error('wrong view');
    expect(ids(result.appointments)).toEqual(['a3001']);
    expect(ids(result.reminders)).toEqual(['t0001']);
    expect(ids(result.due)).toEqual(['t0003']);
    expect(result.now).toBe('2026-09-26 10:00 Sat');
    expect(result.timezone).toBe('America/Los_Angeles');
  });
});

describe('agenda: overdue', () => {
  it('lists reminders already past and due dates before today', async () => {
    t = await makeTestContext({ files: FILES });
    const result = await agenda(t.ctx, { view: 'overdue' });
    if ('error' in result) throw new Error('unexpected error');
    if (result.view !== 'overdue') throw new Error('wrong view');
    expect(ids(result.reminders)).toEqual(['t0001']);
    expect(ids(result.due)).toEqual(['t0004']);
  });

  it('does not treat a future reminder or a due-today item as overdue', async () => {
    t = await makeTestContext({ files: FILES, now: '2026-09-26T15:00:00Z' }); // 08:00 Pacific
    const result = await agenda(t.ctx, { view: 'overdue' });
    if ('error' in result) throw new Error('unexpected error');
    if (result.view !== 'overdue') throw new Error('wrong view');
    expect(ids(result.reminders)).toEqual([]); // t0001 fires at 09:00, now is 08:00
    expect(ids(result.due)).toEqual(['t0004']); // due-date overdue is unaffected by time of day
  });
});

describe('agenda: upcoming', () => {
  it('covers tomorrow through today+days, excluding today', async () => {
    t = await makeTestContext({ files: FILES });
    const result = await agenda(t.ctx, { view: 'upcoming' });
    if ('error' in result) throw new Error('unexpected error');
    if (result.view !== 'upcoming') throw new Error('wrong view');
    expect(ids(result.appointments)).toEqual(['a3002']);
    expect(ids(result.reminders)).toEqual(['t0002']);
    expect(ids(result.due)).toEqual(['t0005']); // t1002 (2026-10-05) is outside the 7-day window
  });

  it('respects a custom days window', async () => {
    t = await makeTestContext({ files: FILES });
    const result = await agenda(t.ctx, { view: 'upcoming', days: 10 });
    if ('error' in result) throw new Error('unexpected error');
    if (result.view !== 'upcoming') throw new Error('wrong view');
    expect(ids(result.due)).toEqual(['t0005', 't1002']);
  });
});

describe('agenda: follow_ups', () => {
  it('splits waiting, promised and nudges due', async () => {
    t = await makeTestContext({ files: FILES });
    const result = await agenda(t.ctx, { view: 'follow_ups' });
    if ('error' in result) throw new Error('unexpected error');
    if (result.view !== 'follow_ups') throw new Error('wrong view');
    expect(ids(result.waiting)).toEqual(['t1001', 't1003']);
    expect(ids(result.promised)).toEqual(['t1002']);
    expect(ids(result.nudges_due)).toEqual(['t1003']); // created 2026-09-20, 5-day cadence -> 2026-09-25
  });
});

describe('agenda: recent', () => {
  it('lists Log "added" entries for the requested window, newest first', async () => {
    t = await makeTestContext({
      files: {
        ...FILES,
        'Log/2026-09-26.md': [
          '# Log 2026-09-26',
          '',
          '- 09:14 · iPhone chat · added [[To do#^t0001|Call the dentist]] ⏰ Sat 9:00am',
          '',
        ].join('\n'),
      },
    });
    const result = await agenda(t.ctx, { view: 'recent', days: 1 });
    if ('error' in result) throw new Error('unexpected error');
    if (result.view !== 'recent') throw new Error('wrong view');
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]?.id).toBe('t0001');
  });
});

describe('agenda: brief', () => {
  it('bundles every section, counts, settings and published state', async () => {
    t = await makeTestContext({ files: FILES });
    const before = await agenda(t.ctx, { view: 'brief' });
    if ('error' in before) throw new Error('unexpected error');
    if (before.view !== 'brief') throw new Error('wrong view');

    expect(ids(before.today.appointments)).toEqual(['a3001']);
    expect(ids(before.overdue.due)).toEqual(['t0004']);
    expect(ids(before.upcoming.appointments)).toEqual(['a3002']);
    expect(ids(before.follow_ups.nudges_due)).toEqual(['t1003']);
    expect(ids(before.stale_facts)).toEqual(['f2002']);
    expect(before.counts.appointments_today).toBe(1);
    expect(before.counts.stale_facts).toBe(1);
    expect(before.brief_published_today).toBe(false);
    expect(before.settings).toEqual({ time_zone: 'America/Los_Angeles', brief_time: '07:30' });
    expect(before.warnings).toContain(
      'Repeat not understood: "every blue moon" on "Weird repeat".',
    );
    expect(before.warnings.some((w) => w.includes('every day'))).toBe(false);

    t.ctx.state.markFired('brief:2026-09-26', 'brief');
    const after = await agenda(t.ctx, { view: 'brief' });
    if ('error' in after) throw new Error('unexpected error');
    if (after.view !== 'brief') throw new Error('wrong view');
    expect(after.brief_published_today).toBe(true);
  });

  it('surfaces settings warnings alongside repeat warnings', async () => {
    t = await makeTestContext({
      files: {
        ...FILES,
        '_claudia/Settings.md': [
          '---',
          'claudia: settings',
          '---',
          '# Settings',
          '',
          '- Time zone: America/Los_Angeles',
          '- Brief time: 25:99',
          '- Nudge time: 09:00',
          '- Waiting-on nudge after: 5 days',
          '- Brief fallback after: 90 minutes',
          '',
        ].join('\n'),
      },
    });
    const result = await agenda(t.ctx, { view: 'brief' });
    if ('error' in result) throw new Error('unexpected error');
    if (result.view !== 'brief') throw new Error('wrong view');
    expect(result.warnings.some((w) => w.startsWith('Settings: "Brief time"'))).toBe(true);
  });

  it('recent covers only the last 24 hours, not the full days window', async () => {
    t = await makeTestContext({
      files: {
        ...FILES,
        'Log/2026-09-26.md': [
          '# Log 2026-09-26',
          '',
          '- 09:00 · iPhone chat · added [[To do#^t0001|Call the dentist]]',
          '',
        ].join('\n'),
        'Log/2026-09-25.md': [
          '# Log 2026-09-25',
          '',
          '- 08:00 · iPhone chat · added [[To do#^t0004|Pay rent]]', // more than 24h before 09-26 10:00
          '',
        ].join('\n'),
      },
    });
    const result = await agenda(t.ctx, { view: 'brief' });
    if ('error' in result) throw new Error('unexpected error');
    if (result.view !== 'brief') throw new Error('wrong view');
    expect(result.recent.map((c) => c.id)).toEqual(['t0001']);
  });
});

describe('agenda: input validation', () => {
  it('returns an error-shaped result for an unknown view, never throwing', async () => {
    t = await makeTestContext({ files: FILES });
    await expect(agenda(t.ctx, { view: 'bogus' })).resolves.toBeDefined();
    const result = await agenda(t.ctx, { view: 'bogus' });
    expect('error' in result).toBe(true);
  });

  it('rejects a days value outside 1 to 60', async () => {
    t = await makeTestContext({ files: FILES });
    const tooMany = await agenda(t.ctx, { view: 'upcoming', days: 61 });
    expect('error' in tooMany).toBe(true);
    const tooFew = await agenda(t.ctx, { view: 'upcoming', days: 0 });
    expect('error' in tooFew).toBe(true);
  });
});

describe('renderAgendaText', () => {
  it('renders a short list per section', async () => {
    t = await makeTestContext({ files: FILES });
    const result = await agenda(t.ctx, { view: 'today' });
    if ('error' in result) throw new Error('unexpected error');
    expect(result.text).toBe(renderAgendaText(result));
    expect(result.text).toBe(
      [
        'Appointments:',
        '  - Dentist cleaning at Main St Dental #appointment (🗓️ 2026-09-26 15:00-16:00) [a3001]',
        'Reminders:',
        '  - Call the dentist (⏰ 2026-09-26 09:00) [t0001]',
        'Due:',
        '  - Submit report (📅 2026-09-26) [t0003]',
      ].join('\n'),
    );
  });

  it('shows "Nothing." for an empty overdue view at midnight', async () => {
    t = await makeTestContext({ files: {}, now: '2026-09-27T07:00:00Z' }); // midnight Pacific
    const result = await agenda(t.ctx, { view: 'overdue' });
    if ('error' in result) throw new Error('unexpected error');
    expect(result.text).toBe('Overdue reminders:\n  Nothing.\nOverdue due:\n  Nothing.');
  });
});
