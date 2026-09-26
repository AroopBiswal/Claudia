import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function frontmatterDescription(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return undefined;
  const closingIndex = lines.indexOf('---', 1);
  if (closingIndex < 0) return undefined;
  for (const line of lines.slice(1, closingIndex)) {
    const match = /^description:\s*(.*)$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

describe('plugin commands', () => {
  const commands = ['sweep', 'brief', 'undo'];

  for (const name of commands) {
    it(`${name}.md has a frontmatter description and a body`, () => {
      const path = fileURLToPath(new URL(`../../../plugin/commands/${name}.md`, import.meta.url));
      const text = readFileSync(path, 'utf8');
      const description = frontmatterDescription(text);

      expect(description).toBeDefined();
      expect((description ?? '').length).toBeGreaterThan(10);
      expect(text.trim().length).toBeGreaterThan(text.indexOf('---', 3) + 3);
    });
  }

  it('sweep instructs following the skill rules and a one-line reply', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../../../plugin/commands/sweep.md', import.meta.url)),
      'utf8',
    );
    expect(text).toContain('capture');
    expect(text).toContain('Nothing new to save.');
  });

  it('brief calls agenda view brief and does not push unless asked', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../../../plugin/commands/brief.md', import.meta.url)),
      'utf8',
    );
    expect(text).toContain('agenda');
    expect(text).toContain('brief');
    expect(text).toMatch(/not call `notify`|do not send a push/i);
  });

  it('undo calls update action undo', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../../../plugin/commands/undo.md', import.meta.url)),
      'utf8',
    );
    expect(text).toContain('update');
    expect(text).toContain('undo');
  });
});
