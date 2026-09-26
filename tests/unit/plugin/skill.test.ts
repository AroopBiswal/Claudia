import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const skillPath = fileURLToPath(
  new URL('../../../plugin/skills/claudia/SKILL.md', import.meta.url),
);
const skillText = readFileSync(skillPath, 'utf8');

/** Minimal manual parse of the leading `---` frontmatter block. */
function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  expect(lines[0]).toBe('---');
  const closingIndex = lines.indexOf('---', 1);
  expect(closingIndex).toBeGreaterThan(0);

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) {
      const [, key, value] = match;
      if (key !== undefined && value !== undefined) fields[key] = value;
    }
  }
  return fields;
}

describe('SKILL.md frontmatter', () => {
  const fields = parseFrontmatter(skillText);

  it('declares name: claudia', () => {
    expect(fields.name).toBe('claudia');
  });

  it('has a non-trivial description', () => {
    expect(fields.description).toBeDefined();
    expect((fields.description ?? '').length).toBeGreaterThan(40);
  });
});

describe('SKILL.md body', () => {
  it('mentions every tool from the tool contract', () => {
    for (const tool of ['capture', 'recall', 'agenda', 'update', 'notify']) {
      expect(skillText).toContain(`\`${tool}\``);
    }
  });

  it('mentions every time-expression form from docs/tools.md', () => {
    const forms = [
      'YYYY-MM-DD HH:mm',
      'ISO 8601',
      'today HH:mm',
      'tonight HH:mm',
      'tomorrow HH:mm',
      '<weekday> HH:mm',
      'next <weekday> HH:mm',
      '+Nm',
      '+Nh',
      '+Nd',
      '+1h30m',
      '+Nd HH:mm',
    ];
    for (const form of forms) {
      expect(skillText).toContain(form);
    }
  });

  it('states the silent-save-except-receipt rule', () => {
    expect(skillText).toMatch(/silen/i);
    expect(skillText).toContain('receipt');
    expect(skillText).toContain('Reminder set: Tue 9:00am.');
  });

  it('describes the never-save rule flow', () => {
    expect(skillText).toContain('add_rule');
    expect(skillText).toContain('remove_rule');
    expect(skillText).toContain('refused');
  });

  it('states the sensitive-data rule', () => {
    expect(skillText).toMatch(/passwords/i);
    expect(skillText).toMatch(/PINs/i);
    expect(skillText).toMatch(/account.*card.*ID numbers|card.*account.*ID numbers|ID numbers/i);
  });
});
