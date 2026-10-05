import { describe, expect, it } from 'vitest';
import { parseNote } from '../../../src/vault/note.ts';
import { extractItems } from '../../../src/vault/items.ts';
import { itemLine, itemView } from '../../../src/services/views.ts';

function first(path: string, text: string) {
  const item = extractItems(path, parseNote(text))[0];
  if (!item) throw new Error('no item');
  return item;
}

describe('itemView', () => {
  it('renders a reminder task with an obsidian link to its block', () => {
    const item = first('Tasks/To do.md', '- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^t9x2k\n');
    const v = itemView(item, { vaultName: 'Claudia', today: '2026-09-26' });
    expect(v).toMatchObject({
      id: 't9x2k',
      kind: 'task',
      status: 'open',
      reminder: '2026-09-29 09:00',
      note: 'Tasks/To do.md',
      stale: false,
    });
    expect(v.link).toBe('obsidian://open?vault=Claudia&file=Tasks%2FTo%20do.md%23%5Et9x2k');
    expect(itemLine(item)).toBe('Call the dentist (⏰ 2026-09-29 09:00) [t9x2k]');
  });

  it('exposes created: a datetime for facts, a date for follow-ups, null otherwise', () => {
    const opts = { vaultName: 'Claudia', today: '2026-10-04' };
    const fact = first('People/Alex.md', '# Alex\n\n- Plays cello ➕ 2026-10-04 14:32 ^f1a2b\n');
    expect(itemView(fact, opts).created).toBe('2026-10-04 14:32');
    const followUp = first(
      'Tasks/Follow-ups.md',
      '- [ ] Waiting on [[Alex]]: reply #waiting ➕ 2026-10-01 ^t1a1a\n',
    );
    expect(itemView(followUp, opts).created).toBe('2026-10-01');
    const task = first('Tasks/To do.md', '- [ ] Water plants ^t1a1b\n');
    expect(itemView(task, opts).created).toBeNull();
  });

  it('marks expired facts stale and formats appointments', () => {
    const fact = first('People/Alex.md', '# Alex\n\n- In Lisbon ⌛ 2026-09-01 ^f5r8e\n');
    expect(itemView(fact, { vaultName: 'Claudia', today: '2026-09-26' }).stale).toBe(true);
    const appt = first(
      'Tasks/Appointments.md',
      '- [ ] Dentist #appointment 🗓️ 2026-09-29 15:00-16:00 ^a3k9p\n',
    );
    expect(itemView(appt, { vaultName: 'Claudia', today: '2026-09-26' }).appointment).toBe(
      '2026-09-29 15:00-16:00',
    );
  });
});
