import { describe, expect, it } from 'vitest';
import { parseNote, serializeNote } from '../../../src/vault/note.ts';

// Deterministic PRNG (mulberry32) so failures are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  '\n',
  '\r\n',
  '\r',
  ' ',
  '\t',
  'a',
  'b',
  'c',
  '-',
  '[',
  ']',
  '^',
  '#',
  '⏰',
  '📅',
  '🗓️',
  '🗓',
  '﻿',
  '---',
  'x',
  'X',
];

function randomString(rand: () => number, minLen: number, maxLen: number): string {
  const len = minLen + Math.floor(rand() * (maxLen - minLen));
  let out = '';
  for (let i = 0; i < len; i++) {
    const idx = Math.floor(rand() * ALPHABET.length);
    out += ALPHABET[idx];
  }
  return out;
}

describe('property: parseNote/serializeNote round trip on random strings', () => {
  const rand = mulberry32(20260926);
  for (let i = 0; i < 500; i++) {
    const s = randomString(rand, 0, 40);
    it(`case ${i}: ${JSON.stringify(s).slice(0, 60)}`, () => {
      expect(serializeNote(parseNote(s))).toBe(s);
    });
  }
});
