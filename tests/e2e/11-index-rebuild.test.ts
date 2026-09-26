// E2E scenario 11: the vault is the source of truth (docs/vault-format.md
// intro; CLAUDE.md "Hard rules"). Deleting ~/.claudia/index.db and restarting
// the service must not lose anything: a full rebuild from the vault's
// Markdown finds every item again.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2E, type E2EService } from '../helpers/e2e-service.ts';

interface StructuredCaptureItem {
  index: number;
  status: string;
  id?: string;
}

describe('e2e: index rebuild after deleting index.db', () => {
  let e2e: E2EService;
  let taskId: string;
  let followUpId: string;
  let factId: string;

  beforeAll(async () => {
    e2e = await startE2E();

    const result = await e2e.mcp.callTool({
      name: 'capture',
      arguments: {
        items: [
          { kind: 'task', text: 'Call the dentist', remind_at: 'tuesday 09:00' },
          {
            kind: 'follow_up',
            text: 'send the proposal',
            person: 'Alex Rivera',
            direction: 'promised',
          },
          { kind: 'fact', text: 'Allergic to penicillin', topic: 'Health' },
        ],
      },
    });
    const results = (result.structuredContent as { results: StructuredCaptureItem[] }).results;
    taskId = results[0]!.id!;
    followUpId = results[1]!.id!;
    factId = results[2]!.id!;
  });

  afterAll(async () => {
    await e2e.stop();
  });

  it('finds everything again after the index is deleted and the service restarts', async () => {
    await e2e.restart({ deleteIndex: true });

    const queries: Array<[string, string]> = [
      ['dentist', taskId],
      ['proposal', followUpId],
      ['penicillin', factId],
    ];
    for (const [query, expectedId] of queries) {
      const result = await e2e.mcp.callTool({ name: 'recall', arguments: { query } });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { results: Array<{ id: string }> };
      expect(structured.results.some((r) => r.id === expectedId)).toBe(true);
    }

    // The rebuilt index still knows the task's reminder well enough to fire it.
    e2e.clock.set('2026-09-29T16:00:00Z'); // Tue 09:00 America/Los_Angeles
    await e2e.reauthorize();
    const baseline = e2e.ntfy.messages.length;
    const report = await e2e.tick();
    expect(report.fired).toContain(taskId);
    expect(e2e.ntfy.messages.length).toBeGreaterThan(baseline);
  });
});
