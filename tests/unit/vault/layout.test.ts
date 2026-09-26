import { describe, expect, it } from 'vitest';
import {
  LAYOUT,
  conflictCopyBase,
  doneNotePath,
  isIdManagedPath,
  isIgnoredPath,
  logNotePath,
  noteBasename,
  obsidianUri,
  personNotePath,
  sanitizeNoteName,
  topicNotePath,
  wikiLink,
} from '../../../src/vault/layout.ts';

describe('LAYOUT constants', () => {
  it('matches vault-format.md section 1', () => {
    expect(LAYOUT.todo).toBe('Tasks/To do.md');
    expect(LAYOUT.followUps).toBe('Tasks/Follow-ups.md');
    expect(LAYOUT.appointments).toBe('Tasks/Appointments.md');
    expect(LAYOUT.profile).toBe('Memory/Profile.md');
    expect(LAYOUT.today).toBe('Today.md');
    expect(LAYOUT.recent).toBe('Recently captured.md');
    expect(LAYOUT.readme).toBe('_claudia/README.md');
    expect(LAYOUT.settings).toBe('_claudia/Settings.md');
    expect(LAYOUT.rules).toBe('_claudia/Rules.md');
  });
});

describe('sanitizeNoteName', () => {
  it('strips forbidden characters and collapses whitespace', () => {
    expect(sanitizeNoteName('Alex "Al" Smith / [Team]?')).toBe('Alex Al Smith Team');
    expect(sanitizeNoteName('  Multiple   Spaces  ')).toBe('Multiple Spaces');
    expect(sanitizeNoteName('a\\b:c*d?e"f<g>h|i#j^k[l]m')).toBe('abcdefghijklm');
  });
});

describe('path helpers', () => {
  it('builds standard note paths', () => {
    expect(doneNotePath('2026-09')).toBe('Tasks/Done/2026-09.md');
    expect(personNotePath('Alex')).toBe('People/Alex.md');
    expect(topicNotePath('Travel')).toBe('Memory/Topics/Travel.md');
    expect(logNotePath('2026-09-26')).toBe('Log/2026-09-26.md');
  });

  it('sanitizes names used in person/topic paths', () => {
    expect(personNotePath('Alex/Smith')).toBe('People/AlexSmith.md');
  });

  it('extracts basenames without the .md extension', () => {
    expect(noteBasename('Tasks/To do.md')).toBe('To do');
    expect(noteBasename('People/Alex.md')).toBe('Alex');
    expect(noteBasename('Alex.md')).toBe('Alex');
  });
});

describe('wikiLink', () => {
  it('builds a link with block id and label per the contract example', () => {
    expect(wikiLink('Tasks/To do.md', 't9x2k', 'Call the dentist')).toBe(
      '[[To do#^t9x2k|Call the dentist]]',
    );
  });

  it('builds a bare link with no id or label', () => {
    expect(wikiLink('People/Alex.md')).toBe('[[Alex]]');
  });

  it('strips | and ] and collapses newlines in the label', () => {
    expect(wikiLink('Tasks/To do.md', 't1a1a', 'a|b]c\nd')).toBe('[[To do#^t1a1a|abc d]]');
  });
});

describe('obsidianUri', () => {
  it('matches the contract example exactly', () => {
    expect(obsidianUri('Claudia', 'Tasks/To do.md', 't9x2k')).toBe(
      'obsidian://open?vault=Claudia&file=Tasks%2FTo%20do.md%23%5Et9x2k',
    );
  });

  it('omits the anchor when no block id is given', () => {
    expect(obsidianUri('Claudia', 'Tasks/To do.md')).toBe(
      'obsidian://open?vault=Claudia&file=Tasks%2FTo%20do.md',
    );
  });
});

describe('isIgnoredPath', () => {
  it('ignores dot-folders, .obsidian and .trash', () => {
    expect(isIgnoredPath('.obsidian/workspace.md')).toBe(true);
    expect(isIgnoredPath('.trash/old.md')).toBe(true);
    expect(isIgnoredPath('.hidden/note.md')).toBe(true);
  });

  it('does not ignore ordinary vault notes', () => {
    expect(isIgnoredPath('Tasks/To do.md')).toBe(false);
    expect(isIgnoredPath('Notes/Ideas.md')).toBe(false);
  });
});

describe('isIdManagedPath', () => {
  it('covers Tasks/**, People/**, Memory/** and Rules.md', () => {
    expect(isIdManagedPath('Tasks/To do.md')).toBe(true);
    expect(isIdManagedPath('People/Alex.md')).toBe(true);
    expect(isIdManagedPath('Memory/Topics/Travel.md')).toBe(true);
    expect(isIdManagedPath('_claudia/Rules.md')).toBe(true);
  });

  it('excludes everything else', () => {
    expect(isIdManagedPath('_claudia/Settings.md')).toBe(false);
    expect(isIdManagedPath('Notes/Ideas.md')).toBe(false);
  });
});

describe('conflictCopyBase', () => {
  it('recognizes iCloud-style conflict copy names', () => {
    expect(conflictCopyBase('Tasks/To do 2.md')).toBe('Tasks/To do.md');
    expect(conflictCopyBase('Tasks/To do 13.md')).toBe('Tasks/To do.md');
  });

  it('rejects names that are not conflict copies', () => {
    expect(conflictCopyBase('Tasks/To do.md')).toBeNull();
    expect(conflictCopyBase('Tasks/To do 1.md')).toBeNull();
    expect(conflictCopyBase('Tasks/Chapter 2.md')).toBe('Tasks/Chapter.md');
  });
});
