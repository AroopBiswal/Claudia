import { describe, expect, it } from 'vitest';
import {
  isValidFieldValue,
  parseLine,
  removeField,
  renderItemLine,
  setBlockId,
  setDescription,
  setField,
  setStatus,
} from '../../../src/vault/line.ts';

describe('parseLine', () => {
  it('parses a plain open task with a reminder and repeat', () => {
    const p = parseLine('- [ ] Laundry ⏰ 2026-09-27 19:00 🔁 every week on Sunday ^t2b7m');
    expect(p.isListItem).toBe(true);
    expect(p.isTask).toBe(true);
    expect(p.status).toBe(' ');
    expect(p.description).toBe('Laundry');
    expect(p.fields.reminder).toBe('2026-09-27 19:00');
    expect(p.fields.repeat).toBe('every week on Sunday');
    expect(p.blockId).toBe('t2b7m');
  });

  it('parses a follow-up with a link, tag, created and due fields', () => {
    const p = parseLine(
      '- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-26 📅 2026-10-02 ^t4m1q',
    );
    expect(p.tags).toEqual(['waiting']);
    expect(p.links).toEqual([{ target: 'Alex', anchor: null, alias: null }]);
    expect(p.fields.created).toBe('2026-09-26');
    expect(p.fields.due).toBe('2026-10-02');
    expect(p.description).toBe('Waiting on [[Alex]]: resume draft #waiting');
    expect(p.blockId).toBe('t4m1q');
  });

  it('parses an appointment with a time range', () => {
    const p = parseLine(
      '- [ ] Dentist cleaning at Main St Dental #appointment 🗓️ 2026-09-29 15:00-16:00 ^a3k9p',
    );
    expect(p.fields.appointment).toBe('2026-09-29 15:00-16:00');
    expect(p.tags).toEqual(['appointment']);
    expect(p.blockId).toBe('a3k9p');
  });

  it('recognizes the appointment emoji without VS16', () => {
    const p = parseLine('- [ ] Vet visit #appointment 🗓 2026-09-30 10:00-10:30 ^a1v2w');
    expect(p.fields.appointment).toBe('2026-09-30 10:00-10:30');
  });

  it('parses a non-task fact line with an expiry', () => {
    const p = parseLine('- Staying in Lisbon until mid October ⌛ 2026-10-15 ^f5r8e');
    expect(p.isTask).toBe(false);
    expect(p.isListItem).toBe(true);
    expect(p.fields.expires).toBe('2026-10-15');
    expect(p.description).toBe('Staying in Lisbon until mid October');
    expect(p.blockId).toBe('f5r8e');
  });

  it('parses a rule line and keeps the raw keyword list as one field value', () => {
    const p = parseLine(
      '- Nothing about my therapy sessions 🚫 therapy, therapist, counseling ^r1a2b',
    );
    expect(p.fields.keywords).toBe('therapy, therapist, counseling');
    expect(p.description).toBe('Nothing about my therapy sessions');
  });

  it('parses a date-and-time ➕ on a fact line without leaking the time into the description', () => {
    const p = parseLine('- Prefers aisle seats ⌛ 2026-12-01 ➕ 2026-10-04 14:32 ^f1a2b');
    expect(p.isTask).toBe(false);
    expect(p.fields.created).toBe('2026-10-04 14:32');
    expect(p.fields.expires).toBe('2026-12-01');
    expect(p.description).toBe('Prefers aisle seats');
    expect(p.blockId).toBe('f1a2b');
  });

  it('parses a date-and-time ➕ on a line with odd spacing', () => {
    const p = parseLine('-   Likes\tjazz  \t ➕ 2026-10-04 14:32\t  ^f1a2b  ');
    expect(p.fields.created).toBe('2026-10-04 14:32');
    expect(p.description).toBe('Likes\tjazz');
    expect(p.blockId).toBe('f1a2b');
  });

  it('still parses a date-only ➕ exactly as before', () => {
    const p = parseLine(
      '- [ ] Waiting on [[Alex]]: reply #waiting ➕ 2026-10-04 📅 2026-10-09 ^t1a1a',
    );
    expect(p.fields.created).toBe('2026-10-04');
    expect(p.fields.due).toBe('2026-10-09');
    expect(p.description).toBe('Waiting on [[Alex]]: reply #waiting');
  });

  it('does not take an out-of-range time as part of ➕', () => {
    const p = parseLine('- Likes jazz ➕ 2026-10-04 25:99 ^f1a2b');
    expect(p.fields.created).toBe('2026-10-04');
  });

  it('keeps trailing non-field text after a valid date value as description, in place', () => {
    const p = parseLine('- [ ] 📅 2026-10-01 party ^t1a1a');
    expect(p.fields.due).toBe('2026-10-01');
    expect(p.description).toBe('party');
  });

  it('treats an invalid date value as plain description text', () => {
    const p = parseLine('- 📅 not-a-date stays as description ^t0a0a');
    expect(p.fields.due).toBeUndefined();
    expect(p.description).toContain('📅 not-a-date stays as description');
  });

  it('does not treat a status box with two characters as a task', () => {
    const p = parseLine('- [xx] Two chars in the box is not a valid task box');
    expect(p.isTask).toBe(false);
    expect(p.description).toBe('[xx] Two chars in the box is not a valid task box');
  });

  it('handles an empty task box with nothing after it', () => {
    const p = parseLine('- [ ]');
    expect(p.isTask).toBe(true);
    expect(p.status).toBe(' ');
    expect(p.description).toBe('');
  });

  it('parses indent and bullet for a tab-indented nested task', () => {
    const p = parseLine('\t\t- [ ] Grandchild task ^t7g8h');
    expect(p.indent).toBe('\t\t');
    expect(p.bullet).toBe('-');
    expect(p.isTask).toBe(true);
  });

  it('parses numbered bullets', () => {
    const p1 = parseLine('1. [ ] First numbered task ^t1n2n');
    expect(p1.bullet).toBe('1.');
    expect(p1.isTask).toBe(true);
    const p2 = parseLine('1) [ ] Second numbered task ^t3n4n');
    expect(p2.bullet).toBe('1)');
  });

  it('does not treat a tag inside a URL or wiki link as a tag', () => {
    const p = parseLine('- See https://example.com/page#section and [[Some#note]] not a #tag');
    expect(p.tags).toEqual(['tag']);
  });

  it('excludes all-digit tokens from tags', () => {
    const p = parseLine('- Room #123 is not a tag but #room12 is');
    expect(p.tags).toEqual(['room12']);
  });
});

describe('isValidFieldValue', () => {
  it('validates date-only fields', () => {
    expect(isValidFieldValue('due', '2026-10-02')).toBe(true);
    expect(isValidFieldValue('due', '2026-10-2')).toBe(false);
    expect(isValidFieldValue('due', 'not-a-date')).toBe(false);
  });

  it('validates ➕ as a date or a date and time', () => {
    expect(isValidFieldValue('created', '2026-10-04')).toBe(true);
    expect(isValidFieldValue('created', '2026-10-04 14:32')).toBe(true);
    expect(isValidFieldValue('created', '2026-10-04 00:00')).toBe(true);
    expect(isValidFieldValue('created', '2026-10-04 23:59')).toBe(true);
    expect(isValidFieldValue('created', '2026-10-04 25:99')).toBe(false);
    expect(isValidFieldValue('created', '2026-10-04 24:00')).toBe(false);
    expect(isValidFieldValue('created', '2026-10-04 14:60')).toBe(false);
    expect(isValidFieldValue('created', '2026-10-04 9:05')).toBe(false);
    expect(isValidFieldValue('created', '2026-10-04 14:32-15:00')).toBe(false);
    // Other date-only fields stay date-only.
    expect(isValidFieldValue('due', '2026-10-04 14:32')).toBe(false);
  });

  it('validates datetime fields', () => {
    expect(isValidFieldValue('reminder', '2026-09-29 09:00')).toBe(true);
    expect(isValidFieldValue('reminder', '2026-09-29')).toBe(false);
  });

  it('validates appointment ranges', () => {
    expect(isValidFieldValue('appointment', '2026-09-29 15:00-16:00')).toBe(true);
    expect(isValidFieldValue('appointment', '2026-09-29 15:00')).toBe(true);
    expect(isValidFieldValue('appointment', '2026-09-29')).toBe(false);
  });

  it('requires non-empty free text for keywords and repeat', () => {
    expect(isValidFieldValue('repeat', 'every week')).toBe(true);
    expect(isValidFieldValue('repeat', '   ')).toBe(false);
    expect(isValidFieldValue('keywords', '')).toBe(false);
  });
});

describe('setField / removeField / setStatus / setBlockId / setDescription surgical edits', () => {
  it('replaces an existing field value in place without touching anything else', () => {
    const raw = '- [ ]  Laundry   ⏰ 2026-09-27 19:00  🔁 every week on Sunday  ^t2b7m';
    const updated = setField(raw, 'reminder', '2026-09-28 07:00');
    expect(updated).toBe('- [ ]  Laundry   ⏰ 2026-09-28 07:00  🔁 every week on Sunday  ^t2b7m');
  });

  it('inserts a new field at its canonical position before a later field', () => {
    const raw = '- [ ] Laundry 🔁 every week on Sunday ^t2b7m';
    const updated = setField(raw, 'reminder', '2026-09-27 19:00');
    expect(updated).toBe('- [ ] Laundry ⏰ 2026-09-27 19:00 🔁 every week on Sunday ^t2b7m');
  });

  it('inserts a new field at the end, before the block id, when nothing later exists', () => {
    const raw = '- [ ] Renew passport ^t8c1d';
    const updated = setField(raw, 'due', '2026-11-01');
    expect(updated).toBe('- [ ] Renew passport 📅 2026-11-01 ^t8c1d');
  });

  it('inserts between two existing fields respecting canonical order', () => {
    const raw = '- [ ] Task ⏰ 2026-09-27 19:00 📅 2026-10-01 ^t1a1a';
    const updated = setField(raw, 'repeat', 'every day');
    expect(updated).toBe('- [ ] Task ⏰ 2026-09-27 19:00 🔁 every day 📅 2026-10-01 ^t1a1a');
  });

  it('removes a field and its leading space, leaving everything else identical', () => {
    const raw = '- [ ]  Laundry   ⏰ 2026-09-27 19:00  🔁 every week on Sunday  ^t2b7m';
    const updated = removeField(raw, 'reminder');
    expect(updated).toBe('- [ ]  Laundry    🔁 every week on Sunday  ^t2b7m');
  });

  it('round trips a datetime ➕ through setField and removeField byte-exact', () => {
    const raw = '-  Likes   jazz  ⌛ 2026-12-01\t➕ 2026-10-04 14:32  ^f1a2b';
    expect(setField(raw, 'created', '2026-10-05 09:01')).toBe(
      '-  Likes   jazz  ⌛ 2026-12-01\t➕ 2026-10-05 09:01  ^f1a2b',
    );
    expect(setField(raw, 'created', '2026-10-04 14:32')).toBe(raw);
    expect(removeField(raw, 'created')).toBe('-  Likes   jazz  ⌛ 2026-12-01  ^f1a2b');
    // Adding it goes after ⌛ and before the block id.
    expect(setField('- Likes jazz ⌛ 2026-12-01 ^f1a2b', 'created', '2026-10-04 14:32')).toBe(
      '- Likes jazz ⌛ 2026-12-01 ➕ 2026-10-04 14:32 ^f1a2b',
    );
    // Switching a date-only ➕ to a datetime and back leaves other bytes alone.
    const dateOnly = '- [ ] Ask Alex #waiting ➕ 2026-10-04 📅 2026-10-09 ^t1a1a';
    expect(setField(dateOnly, 'created', '2026-10-04 14:32')).toBe(
      '- [ ] Ask Alex #waiting ➕ 2026-10-04 14:32 📅 2026-10-09 ^t1a1a',
    );
  });

  it('removeField is a no-op when the field is absent', () => {
    const raw = '- [ ] Laundry ^t2b7m';
    expect(removeField(raw, 'due')).toBe(raw);
  });

  it('setStatus only changes the character inside the brackets', () => {
    const raw = '- [ ]  Laundry   ⏰ 2026-09-27 19:00  ^t2b7m';
    expect(setStatus(raw, 'x')).toBe('- [x]  Laundry   ⏰ 2026-09-27 19:00  ^t2b7m');
  });

  it('setStatus is a no-op on a non-task line', () => {
    const raw = '- Staying in Lisbon ⌛ 2026-10-15 ^f5r8e';
    expect(setStatus(raw, 'x')).toBe(raw);
  });

  it('setBlockId replaces an existing id in place, keeping trailing whitespace', () => {
    const raw = '- [ ] Laundry ^t2b7m  ';
    expect(setBlockId(raw, 't9z9z')).toBe('- [ ] Laundry ^t9z9z  ');
  });

  it('setBlockId appends when there is no existing id', () => {
    const raw = '- [ ] Laundry';
    expect(setBlockId(raw, 't9z9z')).toBe('- [ ] Laundry ^t9z9z');
  });

  it('setDescription replaces the description text, keeping fields and id', () => {
    const raw = '- [ ] Laundry ⏰ 2026-09-27 19:00 ^t2b7m';
    expect(setDescription(raw, 'Weekly laundry')).toBe(
      '- [ ] Weekly laundry ⏰ 2026-09-27 19:00 ^t2b7m',
    );
  });

  it('setDescription works when there are no fields, only a block id', () => {
    const raw = '- [ ] Laundry ^t2b7m';
    expect(setDescription(raw, 'Weekly laundry')).toBe('- [ ] Weekly laundry ^t2b7m');
  });

  it('odd-spacing golden: editing one field changes only the target bytes', () => {
    const raw = '- [ ]\tLaundry\t\t⏰ 2026-09-27 19:00\t🔁 every week on Sunday   ^t2b7m';
    const updated = setField(raw, 'due', '2026-10-05');
    // Only the due field is newly inserted; every original byte must still be present, unchanged elsewhere.
    expect(updated).toContain('\tLaundry\t\t⏰ 2026-09-27 19:00\t🔁 every week on Sunday');
    expect(updated).toContain('📅 2026-10-05');
    expect(updated.endsWith('^t2b7m')).toBe(true);
  });
});

describe('renderItemLine canonical examples', () => {
  it('renders a task with reminder and repeat', () => {
    const line = renderItemLine({
      task: true,
      status: ' ',
      description: 'Laundry',
      fields: { reminder: '2026-09-27 19:00', repeat: 'every week on Sunday' },
      blockId: 't2b7m',
    });
    expect(line).toBe('- [ ] Laundry ⏰ 2026-09-27 19:00 🔁 every week on Sunday ^t2b7m');
    expect(parseLine(line)).toMatchObject({
      isTask: true,
      status: ' ',
      description: 'Laundry',
      fields: { reminder: '2026-09-27 19:00', repeat: 'every week on Sunday' },
      blockId: 't2b7m',
    });
  });

  it('renders a follow-up with a tag, created and due', () => {
    const line = renderItemLine({
      task: true,
      status: ' ',
      description: 'Waiting on [[Alex]]: resume draft',
      tags: ['waiting'],
      fields: { created: '2026-09-26', due: '2026-10-02' },
      blockId: 't4m1q',
    });
    expect(line).toBe(
      '- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-26 📅 2026-10-02 ^t4m1q',
    );
    const parsed = parseLine(line);
    expect(parsed.tags).toEqual(['waiting']);
    expect(parsed.fields.created).toBe('2026-09-26');
    expect(parsed.fields.due).toBe('2026-10-02');
    expect(parsed.blockId).toBe('t4m1q');
  });

  it('renders an appointment', () => {
    const line = renderItemLine({
      task: true,
      status: ' ',
      description: 'Dentist cleaning at Main St Dental',
      tags: ['appointment'],
      fields: { appointment: '2026-09-29 15:00-16:00' },
      blockId: 'a3k9p',
    });
    expect(line).toBe(
      '- [ ] Dentist cleaning at Main St Dental #appointment 🗓️ 2026-09-29 15:00-16:00 ^a3k9p',
    );
    const parsed = parseLine(line);
    expect(parsed.fields.appointment).toBe('2026-09-29 15:00-16:00');
    expect(parsed.blockId).toBe('a3k9p');
  });

  it('renders a non-task fact with expiry', () => {
    const line = renderItemLine({
      task: false,
      description: 'Staying in Lisbon until mid October',
      fields: { expires: '2026-10-15' },
      blockId: 'f5r8e',
    });
    expect(line).toBe('- Staying in Lisbon until mid October ⌛ 2026-10-15 ^f5r8e');
    const parsed = parseLine(line);
    expect(parsed.isTask).toBe(false);
    expect(parsed.fields.expires).toBe('2026-10-15');
    expect(parsed.blockId).toBe('f5r8e');
  });

  it('renders a fact with expiry and a datetime ➕ in canonical order', () => {
    const line = renderItemLine({
      task: false,
      description: 'Staying in Lisbon until mid October',
      fields: { created: '2026-10-04 14:32', expires: '2026-10-15' },
      blockId: 'f5r8e',
    });
    expect(line).toBe(
      '- Staying in Lisbon until mid October ⌛ 2026-10-15 ➕ 2026-10-04 14:32 ^f5r8e',
    );
    const parsed = parseLine(line);
    expect(parsed.fields).toEqual({ expires: '2026-10-15', created: '2026-10-04 14:32' });
    expect(parsed.description).toBe('Staying in Lisbon until mid October');
    expect(parsed.blockId).toBe('f5r8e');
  });

  it('renders a rule with keywords', () => {
    const line = renderItemLine({
      task: false,
      description: 'Nothing about my therapy sessions',
      fields: { keywords: 'therapy, therapist, counseling' },
      blockId: 'r1a2b',
    });
    expect(line).toBe(
      '- Nothing about my therapy sessions 🚫 therapy, therapist, counseling ^r1a2b',
    );
    const parsed = parseLine(line);
    expect(parsed.fields.keywords).toBe('therapy, therapist, counseling');
    expect(parsed.blockId).toBe('r1a2b');
  });
});
