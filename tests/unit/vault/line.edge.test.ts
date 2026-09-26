import { describe, expect, it } from 'vitest';
import { parseLine, setField } from '../../../src/vault/line.ts';

describe('parseLine: URL in the description containing "#" and "^"', () => {
  it('keeps the URL intact in the description, does not treat "#anchor" as a tag, and still finds the real block id', () => {
    const raw = '- [ ] Check the doc https://example.com/page#section^extra for details ^t9x2k';
    const p = parseLine(raw);
    expect(p.blockId).toBe('t9x2k');
    expect(p.description).toBe('Check the doc https://example.com/page#section^extra for details');
    expect(p.tags).toEqual([]);
  });

  it('does not misread a caret inside a URL as the block id when the URL is the last token', () => {
    // No real block id here; the trailing "^extra" is part of the URL (no preceding whitespace
    // before the caret), so it must not be mistaken for " ^blockid".
    const raw = '- [ ] See https://example.com/page#section^extra';
    const p = parseLine(raw);
    expect(p.blockId).toBeNull();
    expect(p.description).toBe('See https://example.com/page#section^extra');
  });
});

describe('parseLine: wiki link with a block-id anchor, [[Alex#^f1a9|Alex]]', () => {
  it('parses target, anchor and alias separately', () => {
    const p = parseLine('- Waiting on [[Alex#^f1a9|Alex]] for the referral ^t4m1q');
    expect(p.links).toEqual([{ target: 'Alex', anchor: '^f1a9', alias: 'Alex' }]);
    expect(p.blockId).toBe('t4m1q');
    expect(p.description).toBe('Waiting on [[Alex#^f1a9|Alex]] for the referral');
  });

  it('parses an anchor with no alias', () => {
    const p = parseLine('- See [[Alex#^f1a9]] ^t1a1a');
    expect(p.links).toEqual([{ target: 'Alex', anchor: '^f1a9', alias: null }]);
  });
});

describe('parseLine: two ⏰ tokens on one line', () => {
  const raw = '- [ ] Call back ⏰ 2026-09-27 09:00 about the trip ⏰ 2026-10-01 10:00 ^t5t5t';

  it('the first (leftmost) ⏰ token wins as the reminder field', () => {
    const p = parseLine(raw);
    expect(p.fields.reminder).toBe('2026-09-27 09:00');
  });

  it('the second, losing, ⏰ token is left untouched as literal description text', () => {
    const p = parseLine(raw);
    expect(p.description).toContain('⏰ 2026-10-01 10:00');
    // The winning (first) occurrence is removed from the description; the losing occurrence's
    // surrounding whitespace is not collapsed, so a double space remains where it was.
    expect(p.description).toBe('Call back  about the trip ⏰ 2026-10-01 10:00');
  });

  it('setField edits the winning (first) occurrence that parseLine reports, leaving the second literal token alone', () => {
    const updated = setField(raw, 'reminder', '2026-09-28 07:00');
    expect(updated).toBe(
      '- [ ] Call back ⏰ 2026-09-28 07:00 about the trip ⏰ 2026-10-01 10:00 ^t5t5t',
    );
    // Re-parsing confirms the field is still the (now-updated) first occurrence.
    const reparsed = parseLine(updated);
    expect(reparsed.fields.reminder).toBe('2026-09-28 07:00');
  });
});

describe('parseLine / setField: 🗓 (appointment) without VS16 round trips', () => {
  it('parses the value the same with or without the variation selector', () => {
    const withVs16 = parseLine('- [ ] Vet visit 🗓️ 2026-09-30 10:00-10:30 ^a1v2w');
    const withoutVs16 = parseLine('- [ ] Vet visit 🗓 2026-09-30 10:00-10:30 ^a1v2w');
    expect(withVs16.fields.appointment).toBe('2026-09-30 10:00-10:30');
    expect(withoutVs16.fields.appointment).toBe('2026-09-30 10:00-10:30');
  });

  it('setField on a no-VS16 emoji changes only the value, preserving the exact emoji bytes used', () => {
    const raw = '- [ ] Vet visit 🗓 2026-09-30 10:00-10:30 ^a1v2w';
    const updated = setField(raw, 'appointment', '2026-10-01 11:00-11:30');
    expect(updated).toBe('- [ ] Vet visit 🗓 2026-10-01 11:00-11:30 ^a1v2w');
    // The emoji itself (no VS16, i.e. no trailing U+FE0F) must be byte-for-byte unchanged.
    expect(updated).toContain('visit 🗓 2026-10-01');
    expect(updated.includes('🗓️')).toBe(false);

    const reparsed = parseLine(updated);
    expect(reparsed.fields.appointment).toBe('2026-10-01 11:00-11:30');
  });

  it('inserting a brand-new appointment field always uses the canonical VS16 emoji', () => {
    const raw = '- [ ] New appointment ^a9z9z';
    const updated = setField(raw, 'appointment', '2026-10-01 11:00');
    expect(updated).toBe('- [ ] New appointment 🗓️ 2026-10-01 11:00 ^a9z9z');
  });
});
