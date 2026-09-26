// recall (docs/tools.md): read-only search over facts, people, tasks,
// follow-ups, appointments and rules. Thin wrapper around Index.search that
// validates input with zod and shapes results as ItemView (docs/tools.md
// recall result shape).

import { z } from 'zod';
import type { ClaudiaContext } from './context.ts';
import { nowLabel, todayOf } from './context.ts';
import { itemView, type ItemView } from './views.ts';

export const recallInputSchema = z.object({
  query: z
    .string()
    .default('')
    .describe('Search words. An empty query with `person` set lists everything about that person.'),
  kinds: z
    .array(z.enum(['task', 'follow_up', 'appointment', 'fact', 'rule']))
    .optional()
    .describe('Restrict results to these kinds.'),
  person: z.string().min(1).optional().describe("Only items linked to this person's People note."),
  include_done: z
    .boolean()
    .optional()
    .describe('Include done/cancelled items too (facts and rules have no done state).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of results to return, 1 to 50.'),
});

export type RecallInput = z.input<typeof recallInputSchema>;

export interface RecallResult {
  now: string;
  total: number;
  results: ItemView[];
}

export interface RecallError {
  error: string;
}

/** Search facts, people, tasks, follow-ups, appointments and rules by words. Read-only. */
export function recall(ctx: ClaudiaContext, input: unknown): RecallResult | RecallError {
  const parsed = recallInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: z.prettifyError(parsed.error) };
  }

  const { query, kinds, person, include_done, limit } = parsed.data;

  if (query.trim() === '' && !person) {
    return { error: 'recall needs a query, a person, or both.' };
  }

  const { total, results } = ctx.index.search({
    query,
    kinds,
    person,
    includeDone: include_done,
    limit,
  });

  const today = todayOf(ctx);
  return {
    now: nowLabel(ctx),
    total,
    results: results.map((item) => itemView(item, { vaultName: ctx.vaultName, today })),
  };
}
