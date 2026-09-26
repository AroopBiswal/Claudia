import { afterEach, describe, expect, it } from 'vitest';
import { capture } from '../../../src/services/capture.ts';
import type { CalendarStatus, CalendarSync } from '../../../src/services/context.ts';
import { applyLinkAction, update } from '../../../src/services/update.ts';
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

describe('update: complete', () => {
  it("marks a task done with today's date and removes any snooze", async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Buy milk 💤 2026-09-27 08:00 ^t0001\n' },
    });
    const res = await update(t.ctx, { action: 'complete', id: 't0001' });
    expect(res.status).toBe('ok');
    expect(res.item?.status).toBe('done');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe('# To do\n\n- [x] Buy milk ✅ 2026-09-26 ^t0001\n');

    const log = await t.ctx.writer.read('Log/2026-09-26.md');
    expect(log).toBe(
      '# Log 2026-09-26\n\n- 10:00 · Claudia · completed [[To do#^t0001|Buy milk]]\n',
    );
  });

  it('accepts an id with a leading caret', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Buy milk ^t0001\n' },
    });
    const res = await update(t.ctx, { action: 'complete', id: '^t0001' });
    expect(res.status).toBe('ok');
    expect(res.id).toBe('t0001');
  });

  it('marks an appointment done without repeating', async () => {
    t = await makeTestContext({
      files: {
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001\n',
      },
    });
    const res = await update(t.ctx, { action: 'complete', id: 'a0001' });
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/Appointments.md');
    expect(text).toBe(
      '# Appointments\n\n- [x] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ✅ 2026-09-26 ^a0001\n',
    );
  });

  it('does not delete the calendar event when completing an appointment', async () => {
    const cal = fakeCalendar('created');
    t = await makeTestContext({
      calendar: cal,
      files: {
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001\n',
      },
    });
    await update(t.ctx, { action: 'complete', id: 'a0001' });
    expect(cal.cancelled).toEqual([]);
  });

  it('returns not_found for an unknown id', async () => {
    t = await makeTestContext();
    const res = await update(t.ctx, { action: 'complete', id: 'tzzzz' });
    expect(res.status).toBe('not_found');
  });

  it('inserts the next occurrence above a completed weekly repeat, shifting across a DST boundary', async () => {
    // Laundry every Sunday at 19:00; completed early on 2026-10-31 (Saturday) while
    // the current occurrence's reminder is still 2026-11-01 (Sunday) 19:00. The US
    // switches out of daylight saving time overnight between those two dates; the
    // shift is by calendar days on the floating date, so the wall-clock time of day
    // is unaffected either way.
    t = await makeTestContext({
      now: '2026-10-31T16:00:00Z', // 2026-10-31 09:00 PDT (before the Nov 1 fall-back)
      files: {
        'Tasks/To do.md':
          '# To do\n\n- [ ] Laundry ⏰ 2026-11-01 19:00 🔁 every week on Sunday ^t2b7m\n',
      },
    });
    const res = await update(t.ctx, { action: 'complete', id: 't2b7m' });
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toContain(
      '- [x] Laundry ⏰ 2026-11-01 19:00 🔁 every week on Sunday ✅ 2026-10-31 ^t2b7m',
    );
    expect(text).toMatch(
      /- \[ \] Laundry ⏰ 2026-11-08 19:00 🔁 every week on Sunday \^t[a-z0-9]{4}\n/,
    );
    // The new occurrence is inserted above the completed one.
    expect(text!.indexOf('2026-11-08')).toBeLessThan(text!.indexOf('2026-10-31'));
  });

  it('does not repeat when the rule is not understood', async () => {
    t = await makeTestContext({
      files: {
        'Tasks/To do.md':
          '# To do\n\n- [ ] Odd thing ⏰ 2026-09-27 09:00 🔁 every blue moon ^t0001\n',
      },
    });
    await update(t.ctx, { action: 'complete', id: 't0001' });
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe(
      '# To do\n\n- [x] Odd thing ⏰ 2026-09-27 09:00 🔁 every blue moon ✅ 2026-09-26 ^t0001\n',
    );
  });
});

describe('update: log labels stay clean of synthetic tags', () => {
  it('a completed follow-up logs without the #waiting tag', async () => {
    t = await makeTestContext({
      files: {
        'Tasks/Follow-ups.md':
          '# Follow-ups\n\n- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-20 ^t0001\n',
      },
    });
    await update(t.ctx, { action: 'complete', id: 't0001' });
    const log = await t.ctx.writer.read('Log/2026-09-26.md');
    expect(log).toContain('completed [[Follow-ups#^t0001|');
    expect(log).toContain('Waiting on');
    expect(log).toContain('resume draft');
    expect(log).not.toContain('#waiting');
  });
});

describe('update: reopen', () => {
  it('reopens a done task', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [x] Buy milk ✅ 2026-09-25 ^t0001\n' },
    });
    const res = await update(t.ctx, { action: 'reopen', id: 't0001' });
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe('# To do\n\n- [ ] Buy milk ^t0001\n');
  });
});

describe('update: snooze', () => {
  it('sets 💤 when there is no existing reminder', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Buy milk ^t0001\n' },
    });
    const res = await update(t.ctx, { action: 'snooze', id: 't0001', until: '+1h' });
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe('# To do\n\n- [ ] Buy milk 💤 2026-09-26 11:00 ^t0001\n');
  });

  it('rejects a snooze that is not after the current reminder', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^t0001\n' },
    });
    const res = await update(t.ctx, { action: 'snooze', id: 't0001', until: '2026-09-28 09:00' });
    expect(res.status).toBe('invalid');
    expect(res.message).toMatch(/use reschedule/);
  });

  it('accepts a snooze after the current reminder', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^t0001\n' },
    });
    const res = await update(t.ctx, { action: 'snooze', id: 't0001', until: '2026-09-30 09:00' });
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe(
      '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-29 09:00 💤 2026-09-30 09:00 ^t0001\n',
    );
  });
});

describe('update: reschedule', () => {
  it('sets a new reminder and clears any snooze', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Buy milk 💤 2026-09-27 08:00 ^t0001\n' },
    });
    const res = await update(t.ctx, {
      action: 'reschedule',
      id: 't0001',
      remind_at: 'tuesday 09:00',
    });
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe('# To do\n\n- [ ] Buy milk ⏰ 2026-09-29 09:00 ^t0001\n');
  });

  it('removes the reminder with an empty string', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Buy milk ⏰ 2026-09-29 09:00 ^t0001\n' },
    });
    const res = await update(t.ctx, { action: 'reschedule', id: 't0001', remind_at: '' });
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe('# To do\n\n- [ ] Buy milk ^t0001\n');
  });

  it('removes the due date with an empty string', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Renew passport 📅 2026-11-01 ^t0001\n' },
    });
    const res = await update(t.ctx, { action: 'reschedule', id: 't0001', due: '' });
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe('# To do\n\n- [ ] Renew passport ^t0001\n');
  });

  it('rejects a past reminder', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Buy milk ^t0001\n' },
    });
    const res = await update(t.ctx, {
      action: 'reschedule',
      id: 't0001',
      remind_at: '2026-09-01 09:00',
    });
    expect(res.status).toBe('invalid');
  });

  it('reschedules an appointment start and default end, and calls the calendar', async () => {
    const cal = fakeCalendar('updated');
    t = await makeTestContext({
      calendar: cal,
      files: {
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001\n',
      },
    });
    const res = await update(t.ctx, {
      action: 'reschedule',
      id: 'a0001',
      start: '2026-09-30 10:00',
    });
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/Appointments.md');
    expect(text).toBe(
      '# Appointments\n\n- [ ] Standup #appointment 🗓️ 2026-09-30 10:00-11:00 ^a0001\n',
    );
    expect(cal.upserted).toEqual(['a0001']);
  });

  it('logs a clean label without the #appointment tag', async () => {
    t = await makeTestContext({
      files: {
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001\n',
      },
    });
    await update(t.ctx, { action: 'reschedule', id: 'a0001', start: '2026-09-30 10:00' });
    const log = await t.ctx.writer.read('Log/2026-09-26.md');
    expect(log).toContain('[[Appointments#^a0001|Standup]]');
    expect(log).not.toContain('#appointment');
  });
});

describe('update: edit', () => {
  it('replaces the description and keeps fields and block id', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Buy milk ⏰ 2026-09-29 09:00 ^t0001\n' },
    });
    const res = await update(t.ctx, { action: 'edit', id: 't0001', text: 'Buy oat milk' });
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe('# To do\n\n- [ ] Buy oat milk ⏰ 2026-09-29 09:00 ^t0001\n');
  });

  it('sets a repeat rule, and removes it with an empty string', async () => {
    t = await makeTestContext({ files: { 'Tasks/To do.md': '# To do\n\n- [ ] Laundry ^t0001\n' } });
    const withRepeat = await update(t.ctx, { action: 'edit', id: 't0001', repeat: 'every day' });
    expect(withRepeat.status).toBe('ok');
    expect(await t.ctx.writer.read('Tasks/To do.md')).toBe(
      '# To do\n\n- [ ] Laundry 🔁 every day ^t0001\n',
    );

    const removed = await update(t.ctx, { action: 'edit', id: 't0001', repeat: '' });
    expect(removed.status).toBe('ok');
    expect(await t.ctx.writer.read('Tasks/To do.md')).toBe('# To do\n\n- [ ] Laundry ^t0001\n');
  });

  it('rejects an unrecognized repeat rule', async () => {
    t = await makeTestContext({ files: { 'Tasks/To do.md': '# To do\n\n- [ ] Laundry ^t0001\n' } });
    const res = await update(t.ctx, { action: 'edit', id: 't0001', repeat: 'every blue moon' });
    expect(res.status).toBe('invalid');
  });
});

describe('update: forget', () => {
  it('deletes the line', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Buy milk ^t0001\n- [ ] Keep me ^t0002\n' },
    });
    const res = await update(t.ctx, { action: 'forget', id: 't0001' });
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe('# To do\n\n- [ ] Keep me ^t0002\n');
  });

  it('cancels the calendar event for a forgotten appointment', async () => {
    const cal = fakeCalendar('created');
    t = await makeTestContext({
      calendar: cal,
      files: {
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001\n',
      },
    });
    const res = await update(t.ctx, { action: 'forget', id: 'a0001' });
    expect(res.status).toBe('ok');
    expect(cal.cancelled).toEqual(['a0001']);
  });
});

describe('update: undo', () => {
  it('says nothing to undo when there is no capture', async () => {
    t = await makeTestContext();
    const res = await update(t.ctx, { action: 'undo' });
    expect(res).toMatchObject({ status: 'ok', message: 'Nothing to undo.' });
  });

  it('removes every line the most recent capture added, and can be undone twice', async () => {
    t = await makeTestContext();
    const cap1 = await capture(t.ctx, { items: [{ kind: 'task', text: 'First' }] });
    const cap2 = await capture(t.ctx, {
      items: [
        { kind: 'task', text: 'Second' },
        { kind: 'task', text: 'Third' },
      ],
    });
    const id1 = cap1.results[0]!.id!;
    const id2 = cap2.results[0]!.id!;
    const id3 = cap2.results[1]!.id!;

    const undo1 = await update(t.ctx, { action: 'undo' });
    expect(undo1.status).toBe('ok');
    let text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).not.toContain('Second');
    expect(text).not.toContain('Third');
    expect(text).toContain('First');
    expect(t.ctx.index.getItem(id2)).toBeNull();
    expect(t.ctx.index.getItem(id3)).toBeNull();

    const undo2 = await update(t.ctx, { action: 'undo' });
    expect(undo2.status).toBe('ok');
    text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).not.toContain('First');
    expect(t.ctx.index.getItem(id1)).toBeNull();

    const undo3 = await update(t.ctx, { action: 'undo' });
    expect(undo3.message).toBe('Nothing to undo.');
  });

  it('cancels calendar events for undone appointments', async () => {
    const cal = fakeCalendar('created');
    t = await makeTestContext({ calendar: cal });
    const cap = await capture(t.ctx, {
      items: [{ kind: 'appointment', text: 'Standup', start: '2026-09-29 09:00' }],
    });
    const id = cap.results[0]!.id!;
    await update(t.ctx, { action: 'undo' });
    expect(cal.cancelled).toEqual([id]);
  });
});

describe('update: rules', () => {
  it('adds a rule and a subsequent capture is refused by it', async () => {
    t = await makeTestContext();
    const added = await update(t.ctx, {
      action: 'add_rule',
      text: 'Nothing about my therapy sessions',
      keywords: ['therapy', 'therapist'],
    });
    expect(added.status).toBe('ok');
    expect(added.id).toMatch(/^r[a-z0-9]{4}$/);

    const res = await capture(t.ctx, { items: [{ kind: 'task', text: 'Book a therapy session' }] });
    expect(res.results[0]!.status).toBe('refused');
  });

  it('rejects add_rule with no keywords', async () => {
    t = await makeTestContext();
    const res = await update(t.ctx, {
      action: 'add_rule',
      text: 'x',
      keywords: [],
    });
    expect(res.status).toBe('invalid');
  });

  it('removes a rule by id, and a subsequent capture is no longer refused', async () => {
    t = await makeTestContext();
    const added = await update(t.ctx, {
      action: 'add_rule',
      text: 'No pets talk',
      keywords: ['hamster'],
    });
    const removed = await update(t.ctx, { action: 'remove_rule', id: added.id! });
    expect(removed.status).toBe('ok');

    const res = await capture(t.ctx, { items: [{ kind: 'task', text: 'Buy hamster food' }] });
    expect(res.results[0]!.status).toBe('saved');
  });
});

describe('update: set_setting', () => {
  it('changes a setting and it is visible via index.settings after the write', async () => {
    t = await makeTestContext();
    const res = await update(t.ctx, {
      action: 'set_setting',
      setting: 'Brief time',
      value: '08:00',
    });
    expect(res.status).toBe('ok');
    expect(t.ctx.index.settings().settings.briefTime).toBe('08:00');
  });

  it('rejects an invalid value', async () => {
    t = await makeTestContext();
    const res = await update(t.ctx, {
      action: 'set_setting',
      setting: 'Brief time',
      value: 'not-a-time',
    });
    expect(res.status).toBe('invalid');
  });
});

describe('applyLinkAction', () => {
  it('done completes the item', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Buy milk ^t0001\n' },
    });
    const res = await applyLinkAction(t.ctx, 'done', 't0001');
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toContain('[x] Buy milk');
  });

  it('done is idempotent: already-done reports "Already done."', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [x] Buy milk ✅ 2026-09-25 ^t0001\n' },
    });
    const res = await applyLinkAction(t.ctx, 'done', 't0001');
    expect(res).toMatchObject({ status: 'ok', message: 'Already done.' });
  });

  it('snooze1h sets the reminder to now + 1 hour when there is no existing reminder', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Buy milk ^t0001\n' },
    });
    const res = await applyLinkAction(t.ctx, 'snooze1h', 't0001');
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe('# To do\n\n- [ ] Buy milk 💤 2026-09-26 11:00 ^t0001\n');
  });

  it('snooze1h reschedules ⏰ instead when now + 1h is not after the current reminder', async () => {
    // now is 2026-09-26 10:00; now + 1h = 11:00, which is not after the 11:30 reminder,
    // so the reminder itself is moved up to 11:00 rather than being snoozed.
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-26 11:30 ^t0001\n' },
    });
    const res = await applyLinkAction(t.ctx, 'snooze1h', 't0001');
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe('# To do\n\n- [ ] Call the dentist ⏰ 2026-09-26 11:00 ^t0001\n');
  });

  it("tomorrow snoozes to tomorrow at the reminder's time of day", async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-26 15:00 ^t0001\n' },
    });
    const res = await applyLinkAction(t.ctx, 'tomorrow', 't0001');
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe(
      '# To do\n\n- [ ] Call the dentist ⏰ 2026-09-26 15:00 💤 2026-09-27 15:00 ^t0001\n',
    );
  });

  it('tomorrow defaults to 09:00 when there is no reminder', async () => {
    t = await makeTestContext({
      files: { 'Tasks/To do.md': '# To do\n\n- [ ] Buy milk ^t0001\n' },
    });
    const res = await applyLinkAction(t.ctx, 'tomorrow', 't0001');
    expect(res.status).toBe('ok');
    const text = await t.ctx.writer.read('Tasks/To do.md');
    expect(text).toBe('# To do\n\n- [ ] Buy milk 💤 2026-09-27 09:00 ^t0001\n');
  });

  it('returns not_found for an unknown id', async () => {
    t = await makeTestContext();
    const res = await applyLinkAction(t.ctx, 'done', 'tzzzz');
    expect(res.status).toBe('not_found');
  });
});
