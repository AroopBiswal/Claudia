import { afterEach, describe, expect, it } from 'vitest';
import { capture } from '../../../src/services/capture.ts';
import type { CalendarStatus, CalendarSync } from '../../../src/services/context.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

interface FakeCalendar extends CalendarSync {
  upserted: string[];
  cancelled: string[];
}

function fakeCalendar(mode: CalendarStatus | 'throw' = 'created'): FakeCalendar {
  const upserted: string[] = [];
  const cancelled: string[] = [];
  return {
    upserted,
    cancelled,
    upsert(id: string) {
      upserted.push(id);
      if (mode === 'throw') throw new Error('calendar boom');
      return Promise.resolve(mode);
    },
    cancel(id: string) {
      cancelled.push(id);
      return Promise.resolve();
    },
    reconcile() {
      return Promise.resolve();
    },
  };
}

const ID_RE = {
  task: /^t[a-z0-9]{4}$/,
  appointment: /^a[a-z0-9]{4}$/,
  fact: /^f[a-z0-9]{4}$/,
};

describe('capture: task', () => {
  it('saves a plain task with no fields', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, { items: [{ kind: 'task', text: 'Buy milk' }] });
    expect(res.now).toBe('2026-09-26 10:00 Sat');
    const r = res.results[0]!;
    expect(r.status).toBe('saved');
    expect(r.id).toMatch(ID_RE.task);
    expect(r.note).toBe('Tasks/To do.md');
    expect(r.line).toBe(`- [ ] Buy milk ^${r.id}`);
    expect(res.receipt).toBeUndefined();

    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe(`# To do\n\n- [ ] Buy milk ^${r.id}\n`);
    expect(t.ctx.index.getItem(r.id!)).not.toBeNull();
  });

  it('saves a timed reminder with the exact vault-format example line and receipt', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [{ kind: 'task', text: 'Call the dentist', remind_at: 'tuesday 09:00' }],
      surface: 'iPhone chat',
      source_words: 'remind me to call the dentist tuesday morning',
    });
    const r = res.results[0]!;
    expect(r.status).toBe('saved');
    expect(r.line).toBe(`- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^${r.id}`);
    expect(r.reminder).toEqual({ local: '2026-09-29 09:00', display: 'Tue 9:00am' });
    expect(res.receipt).toBe('Reminder set: Tue 9:00am.');

    const log = await t.ctx.writer.read('Log/2026-09-26.md');
    expect(log).toBe(
      '# Log 2026-09-26\n\n' +
        `- 10:00 · iPhone chat · added [[To do#^${r.id}|Call the dentist]] ⏰ Tue 9:00am · "remind me to call the dentist tuesday morning"\n`,
    );
  });

  it('saves a due-only task matching the vault-format example', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [{ kind: 'task', text: 'Renew passport', due: '2026-11-01' }],
    });
    const r = res.results[0]!;
    expect(r.line).toBe(`- [ ] Renew passport 📅 2026-11-01 ^${r.id}`);
    expect(r.reminder).toBeUndefined();
  });

  it('saves a repeating reminder matching the vault-format example', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [
        {
          kind: 'task',
          text: 'Laundry',
          remind_at: '2026-09-27 19:00',
          repeat: 'every week on Sunday',
        },
      ],
    });
    const r = res.results[0]!;
    expect(r.line).toBe(`- [ ] Laundry ⏰ 2026-09-27 19:00 🔁 every week on Sunday ^${r.id}`);
  });

  it('combines multiple reminders into one receipt', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [
        { kind: 'task', text: 'A', remind_at: 'tuesday 09:00' },
        { kind: 'task', text: 'B', remind_at: 'sunday 19:00' },
      ],
    });
    expect(res.receipt).toBe('Reminders set: Tue 9:00am; Sun 7:00pm.');
  });

  it('renders tags', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [{ kind: 'task', text: 'Ship it', tags: ['project/claudia'] }],
    });
    const r = res.results[0]!;
    expect(r.line).toBe(`- [ ] Ship it #project/claudia ^${r.id}`);
  });
});

describe('capture: follow_up', () => {
  it('links the person when their name already appears in the text', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [
        {
          kind: 'follow_up',
          text: 'Ping Alex about the draft',
          person: 'Alex',
          direction: 'waiting',
        },
      ],
    });
    const r = res.results[0]!;
    expect(r.note).toBe('Tasks/Follow-ups.md');
    expect(r.line).toBe(`- [ ] Ping [[Alex]] about the draft #waiting ➕ 2026-09-26 ^${r.id}`);
    const personNote = await t.ctx.writer.read('People/Alex.md');
    expect(personNote).toBe('# Alex\n\n');
  });

  it('wraps waiting-on text matching the vault-format example when the name is absent', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [
        {
          kind: 'follow_up',
          text: 'resume draft',
          person: 'Alex',
          direction: 'waiting',
          due: '2026-10-02',
        },
      ],
    });
    const r = res.results[0]!;
    expect(r.line).toBe(
      `- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-26 📅 2026-10-02 ^${r.id}`,
    );
  });

  it('links a promised item matching the vault-format example', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [
        {
          kind: 'follow_up',
          text: 'Send Alex the referral link',
          person: 'Alex',
          direction: 'promised',
          due: '2026-09-30',
        },
      ],
    });
    const r = res.results[0]!;
    expect(r.line).toBe(
      `- [ ] Send [[Alex]] the referral link #promised ➕ 2026-09-26 📅 2026-09-30 ^${r.id}`,
    );
  });

  it('does not create the person note twice if it already exists', async () => {
    t = await makeTestContext({
      files: { 'People/Alex.md': '# Alex\n\n- Friend from college ^f1a9z\n' },
    });
    await capture(t.ctx, {
      items: [{ kind: 'follow_up', text: 'call Alex back', person: 'Alex', direction: 'promised' }],
    });
    const personNote = await t.ctx.writer.read('People/Alex.md');
    expect(personNote).toBe('# Alex\n\n- Friend from college ^f1a9z\n');
  });
});

describe('capture: appointment', () => {
  it('saves an appointment matching the vault-format example and syncs the calendar', async () => {
    const cal = fakeCalendar('created');
    t = await makeTestContext({ calendar: cal });
    const res = await capture(t.ctx, {
      items: [
        {
          kind: 'appointment',
          text: 'Dentist cleaning',
          location: 'Main St Dental',
          start: '2026-09-29 15:00',
        },
      ],
    });
    const r = res.results[0]!;
    expect(r.id).toMatch(ID_RE.appointment);
    expect(r.note).toBe('Tasks/Appointments.md');
    expect(r.line).toBe(
      `- [ ] Dentist cleaning at Main St Dental #appointment 🗓️ 2026-09-29 15:00-16:00 ^${r.id}`,
    );
    expect(r.calendar).toBe('created');
    expect(cal.upserted).toEqual([r.id]);

    const log = await t.ctx.writer.read('Log/2026-09-26.md');
    expect(log).toContain(
      `added [[Appointments#^${r.id}|Dentist cleaning at Main St Dental]] 🗓️ Tue 3:00pm`,
    );
  });

  it('reports not_configured with no calendar client', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [{ kind: 'appointment', text: 'Standup', start: '2026-09-29 09:00' }],
    });
    expect(res.results[0]!.calendar).toBe('not_configured');
  });

  it('reports pending and logs when the calendar throws', async () => {
    const cal = fakeCalendar('throw');
    t = await makeTestContext({ calendar: cal });
    const res = await capture(t.ctx, {
      items: [{ kind: 'appointment', text: 'Standup', start: '2026-09-29 09:00' }],
    });
    expect(res.results[0]!.calendar).toBe('pending');
  });

  it('uses an explicit end time on the same day', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [
        {
          kind: 'appointment',
          text: 'Workshop',
          start: '2026-09-29 09:00',
          end: '2026-09-29 12:00',
        },
      ],
    });
    expect(res.results[0]!.line).toContain('🗓️ 2026-09-29 09:00-12:00');
  });
});

describe('capture: fact', () => {
  it('saves a core profile fact', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, { items: [{ kind: 'fact', text: 'Allergic to penicillin' }] });
    const r = res.results[0]!;
    expect(r.id).toMatch(ID_RE.fact);
    expect(r.note).toBe('Memory/Profile.md');
    expect(r.line).toBe(`- Allergic to penicillin ^${r.id}`);
  });

  it('saves a fact about a person, creating the note', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [{ kind: 'fact', text: 'Job hunting for PM roles', person: 'Alex' }],
    });
    const r = res.results[0]!;
    expect(r.note).toBe('People/Alex.md');
    const text = await t.ctx.writer.read('People/Alex.md');
    expect(text).toBe(`# Alex\n\n- Job hunting for PM roles ^${r.id}\n`);
  });

  it('saves a topic fact with an expiry', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [{ kind: 'fact', text: 'Staying in Lisbon', topic: 'Travel', expires: '2026-10-15' }],
    });
    const r = res.results[0]!;
    expect(r.note).toBe('Memory/Topics/Travel.md');
    expect(r.line).toBe(`- Staying in Lisbon ⌛ 2026-10-15 ^${r.id}`);
  });
});

describe('capture: multi-item, order and isolation', () => {
  it('processes items independently, one saved and one invalid', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [
        { kind: 'task', text: 'Buy milk' },
        { kind: 'follow_up', text: 'ping about the draft', direction: 'waiting' },
      ],
    });
    expect(res.results[0]!.status).toBe('saved');
    expect(res.results[1]!.status).toBe('invalid');
    expect(res.results[1]!.reason).toBe('A person is required.');
    expect(res.results[1]!.index).toBe(1);

    const todo = await t.ctx.writer.read('Tasks/To do.md');
    expect(todo).toContain('Buy milk');
  });
});

describe('capture: refusals', () => {
  it('refuses an item that matches a never-save rule and writes nothing', async () => {
    t = await makeTestContext({
      files: {
        '_claudia/Rules.md':
          '---\nclaudia: rules\n---\n# Never-save rules\n\n- Nothing about my therapy sessions 🚫 therapy, therapist, counseling ^r1a2b\n',
      },
    });
    const res = await capture(t.ctx, { items: [{ kind: 'task', text: 'Book a therapy session' }] });
    const r = res.results[0]!;
    expect(r.status).toBe('refused');
    expect(r.reason).toBe(
      'Matches your never-save rule "Nothing about my therapy sessions" (therapy).',
    );

    const todo = await t.ctx.writer.read('Tasks/To do.md');
    expect(todo).toBe('# To do\n\n');
    const log = await t.ctx.writer.read('Log/2026-09-26.md');
    expect(log).toBeNull();
  });

  it('refuses text that looks like a password and writes nothing', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, { items: [{ kind: 'fact', text: 'My password is hunter2' }] });
    const r = res.results[0]!;
    expect(r.status).toBe('refused');
    expect(r.reason).toBe('Looks like a password or security code; Claudia never saves those.');
    const profile = await t.ctx.writer.read('Memory/Profile.md');
    expect(profile).toBe('# Profile\n\n');
  });
});

describe('capture: duplicates and similar', () => {
  it('flags a near-identical open task as a duplicate and writes nothing', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist to reschedule ^t0001\n' },
    });
    const res = await capture(t.ctx, {
      items: [{ kind: 'task', text: 'Call the dentist to reschedule' }],
    });
    const r = res.results[0]!;
    expect(r.status).toBe('duplicate');
    expect(r.similar).toEqual([
      { id: 't0001', text: 'Call the dentist to reschedule', note: 'Tasks/To do.md' },
    ]);

    const todo = await t.ctx.writer.read('Tasks/To do.md');
    expect(todo).toBe('# To do\n\n- [ ] Call the dentist to reschedule ^t0001\n');
  });

  it('saves a moderately similar task and flags it as similar', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist to reschedule ^t0001\n' },
    });
    const res = await capture(t.ctx, {
      items: [{ kind: 'task', text: 'Call the dentist to reschedule the cleaning' }],
    });
    const r = res.results[0]!;
    expect(r.status).toBe('saved');
    expect(r.similar?.[0]?.id).toBe('t0001');

    const todo = await t.ctx.writer.read('Tasks/To do.md');
    expect(todo).toContain('Call the dentist to reschedule the cleaning');
  });
});

describe('capture: invalid inputs', () => {
  it('rejects a follow_up missing a direction', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, { items: [{ kind: 'follow_up', text: 'x', person: 'Alex' }] });
    expect(res.results[0]).toMatchObject({
      status: 'invalid',
      reason: 'A direction (waiting or promised) is required.',
    });
  });

  it('rejects a reminder in the past', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [{ kind: 'task', text: 'x', remind_at: '2026-09-20 09:00' }],
    });
    expect(res.results[0]!.status).toBe('invalid');
    expect(res.results[0]!.reason).toMatch(/^That time has already passed:/);
  });

  it('rejects an unrecognized repeat rule', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [{ kind: 'task', text: 'x', repeat: 'every blue moon' }],
    });
    expect(res.results[0]!.status).toBe('invalid');
    expect(res.results[0]!.reason).toMatch(/^Could not understand that repeat rule\./);
  });

  it('rejects an unparseable time expression', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, { items: [{ kind: 'task', text: 'x', remind_at: 'blah' }] });
    expect(res.results[0]!.status).toBe('invalid');
    expect(res.results[0]!.reason).toContain('Could not understand "blah" as a time.');
  });

  it('rejects a field that does not apply to the kind', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, { items: [{ kind: 'task', text: 'x', person: 'Alex' }] });
    expect(res.results[0]).toMatchObject({
      status: 'invalid',
      reason: '"person" does not apply to kind "task".',
    });
  });

  it('rejects an appointment missing a start time', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, { items: [{ kind: 'appointment', text: 'x' }] });
    expect(res.results[0]).toMatchObject({
      status: 'invalid',
      reason: 'A start time is required.',
    });
  });

  it('rejects an appointment end on a different day', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [{ kind: 'appointment', text: 'x', start: '2026-09-29 15:00', end: 'tomorrow 10:00' }],
    });
    expect(res.results[0]).toMatchObject({
      status: 'invalid',
      reason: 'The end time must be on the same day as the start.',
    });
  });

  it('rejects an appointment end before the start', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [
        { kind: 'appointment', text: 'x', start: '2026-09-29 15:00', end: '2026-09-29 14:00' },
      ],
    });
    expect(res.results[0]).toMatchObject({
      status: 'invalid',
      reason: 'The end time must be after the start.',
    });
  });
});

describe('capture: text sanitising', () => {
  it('strips fake block ids, field emoji and newlines from user text', async () => {
    t = await makeTestContext();
    const res = await capture(t.ctx, {
      items: [{ kind: 'task', text: 'Do the ^t123 thing ⏰now\nwith newline' }],
    });
    const r = res.results[0]!;
    expect(r.line).toBe(`- [ ] Do the t123 thing now with newline ^${r.id}`);
  });
});
