import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNote, serializeNote } from '../../../src/vault/note.ts';

const fixturesDir = fileURLToPath(new URL('../../fixtures/vault', import.meta.url));

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const fixtureFiles = listFiles(fixturesDir).sort();

describe('parseNote/serializeNote round trip on golden fixtures', () => {
  it('found at least 12 fixture files', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(12);
  });

  for (const file of fixtureFiles) {
    const rel = relative(fixturesDir, file);
    it(`byte-exact round trip: ${rel}`, () => {
      const original = readFileSync(file);
      const text = original.toString('utf8');
      const note = parseNote(text);
      const serialized = serializeNote(note);
      const roundTripped = Buffer.from(serialized, 'utf8');
      expect(roundTripped.equals(original)).toBe(true);
    });
  }
});

describe('parseNote/serializeNote round trip on arbitrary strings', () => {
  const cases = [
    '',
    '\n',
    '\r\n',
    'a',
    'a\n',
    'a\r\n',
    'a\nb',
    'a\r\nb\n',
    '﻿',
    '﻿a\nb\r\n',
    '---\n---\n',
    '---\nclaudia: settings\n---\nbody\n',
    'line with trailing spaces   \n',
    '\t- [ ] tab indented\n',
    'a\rb\n', // lone CR embedded, not a recognized EOL
  ];
  for (const t of cases) {
    it(`round trips ${JSON.stringify(t)}`, () => {
      expect(serializeNote(parseNote(t))).toBe(t);
    });
  }
});
