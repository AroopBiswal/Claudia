import { describe, expect, it } from 'vitest';
import {
  GENERATED_HEADER,
  SEED_FOLDERS,
  SEED_NOTES,
  doneNote,
  logNote,
  personNote,
  topicNote,
} from '../../../src/vault/templates.ts';

const EMOJIS = ['⏰', '💤', '🗓️', '🔁', '📅', '✅', '➕', '⌛', '🚫'];

describe('GENERATED_HEADER', () => {
  it('matches the vault-format contract exactly', () => {
    expect(GENERATED_HEADER).toBe(
      '---\nclaudia: generated\n---\n> Claudia rewrites this note. Edit the notes it links to instead.\n',
    );
  });
});

describe('note builders', () => {
  it('personNote produces a bare heading', () => {
    expect(personNote('Alex')).toBe('# Alex\n\n');
  });

  it('topicNote produces a bare heading', () => {
    expect(topicNote('Travel')).toBe('# Travel\n\n');
  });

  it('logNote includes the date', () => {
    expect(logNote('2026-09-26')).toBe('# Log 2026-09-26\n\n');
  });

  it('doneNote includes the year and month', () => {
    expect(doneNote('2026-09')).toBe('# Done 2026-09\n\n');
  });
});

describe('SEED_FOLDERS', () => {
  it('lists the folders the vault needs on first run', () => {
    expect(SEED_FOLDERS).toEqual([
      'Tasks',
      'Tasks/Done',
      'People',
      'Memory',
      'Memory/Topics',
      'Log',
      '_claudia',
    ]);
  });
});

describe('SEED_NOTES', () => {
  function content(path: string): string {
    const note = SEED_NOTES.find((n) => n.path === path);
    if (!note) throw new Error(`missing seed note ${path}`);
    return note.content;
  }

  it('seeds exactly the expected paths', () => {
    expect(SEED_NOTES.map((n) => n.path).sort()).toEqual(
      [
        '_claudia/README.md',
        '_claudia/Settings.md',
        '_claudia/Rules.md',
        'Tasks/To do.md',
        'Tasks/Follow-ups.md',
        'Tasks/Appointments.md',
        'Memory/Profile.md',
      ].sort(),
    );
  });

  it('Settings.md matches the vault-format contract exactly', () => {
    expect(content('_claudia/Settings.md')).toBe(
      [
        '---',
        'claudia: settings',
        '---',
        '# Settings',
        '',
        'Claudia reads this note. Change a value after the colon and save; delete a line to go back to the default.',
        '',
        '- Time zone: America/Los_Angeles',
        '- Brief time: 07:30',
        '- Nudge time: 09:00',
        '- Waiting-on nudge after: 5 days',
        '- Brief fallback after: 90 minutes',
        '',
      ].join('\n'),
    );
  });

  it('Rules.md matches the vault-format contract exactly, seeded with no rules', () => {
    expect(content('_claudia/Rules.md')).toBe(
      [
        '---',
        'claudia: rules',
        '---',
        '# Never-save rules',
        '',
        'Claudia refuses to save anything that matches one of these rules. Each rule ends with the keywords Claude chose for it, after 🚫. Edit the keywords or delete a line to change a rule.',
        '',
      ].join('\n'),
    );
    expect(content('_claudia/Rules.md')).not.toContain('^r');
  });

  it('README.md declares itself and stays under about 80 lines', () => {
    const readme = content('_claudia/README.md');
    expect(readme.startsWith('---\nclaudia: readme\n---\n')).toBe(true);
    const lineCount = readme.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(85);
  });

  it('README.md mentions every field emoji', () => {
    const readme = content('_claudia/README.md');
    for (const emoji of EMOJIS) {
      expect(readme).toContain(emoji);
    }
  });

  it('README.md explains block IDs and shows the hand-add example', () => {
    const readme = content('_claudia/README.md');
    expect(readme).toContain('^t9x2k');
    expect(readme).toContain('- [ ] Water plants ⏰ 2026-10-01 18:00');
    expect(readme).toContain('Tasks/To do.md');
  });

  it('README.md covers settings, rules, generated notes and the never-delete promise', () => {
    const readme = content('_claudia/README.md');
    expect(readme).toContain('Settings.md');
    expect(readme).toContain('Rules.md');
    expect(readme).toContain('Today.md');
    expect(readme).toContain('Recently captured.md');
    expect(readme).toMatch(/never deletes/i);
    expect(readme).toMatch(/Log/);
  });

  it('every seed note is LF-only with a final newline', () => {
    for (const note of SEED_NOTES) {
      expect(note.content.includes('\r')).toBe(false);
      expect(note.content.endsWith('\n')).toBe(true);
    }
  });

  it('Tasks and Memory seeds are bare headings with no items yet', () => {
    expect(content('Tasks/To do.md')).toBe('# To do\n\n');
    expect(content('Tasks/Follow-ups.md')).toBe('# Follow-ups\n\n');
    expect(content('Tasks/Appointments.md')).toBe('# Appointments\n\n');
    expect(content('Memory/Profile.md')).toBe('# Profile\n\n');
  });
});
