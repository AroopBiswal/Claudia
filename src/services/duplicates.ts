// Near-duplicate detection for capture (Decision Log B12): normalized word
// sets and Jaccard similarity over open items of the same kind. >= 0.8 is a
// duplicate (nothing saved); 0.5 to 0.8 is "similar" (saved, flagged).

import type { IndexedItem } from '../engine/index.ts';
import type { ItemKind } from '../vault/items.ts';
import type { ClaudiaContext } from './context.ts';

export const DUPLICATE_THRESHOLD = 0.8;
export const SIMILAR_THRESHOLD = 0.5;
const SEARCH_LIMIT = 20;

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'my',
  'for',
  'of',
  'and',
  'on',
  'at',
  'in',
  'with',
  'me',
  'i',
]);

/** Lowercase word set, punctuation stripped, stop words dropped. */
export function normalizedWords(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(tokens.filter((t) => !STOP_WORDS.has(t)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface SimilarMatch {
  item: IndexedItem;
  score: number;
}

/**
 * Open items of `kind` whose normalized words are at least SIMILAR_THRESHOLD
 * (0.5) similar to `text`, sorted by score descending. Score >= 0.8 is a
 * duplicate; the caller decides what to do with the result.
 */
export function findSimilar(
  ctx: ClaudiaContext,
  kind: ItemKind,
  text: string,
  opts?: { limit?: number },
): SimilarMatch[] {
  const words = normalizedWords(text);
  if (words.size === 0) return [];

  const { results } = ctx.index.search({
    query: text,
    kinds: [kind],
    includeDone: false,
    limit: opts?.limit ?? SEARCH_LIMIT,
  });

  return results
    .map((item): SimilarMatch => ({ item, score: jaccard(words, normalizedWords(item.text)) }))
    .filter((m) => m.score >= SIMILAR_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}
