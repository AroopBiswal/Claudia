// E2E scenario 10: undo (docs/tools.md "update" action "undo"). Undoing the
// most recent capture call removes every line it added, even when that
// capture saved more than one item, and logs the undo.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2E, type E2EService } from '../helpers/e2e-service.ts';

interface StructuredCaptureItem {
  index: number;
  status: string;
  id?: string;
}

describe('e2e: undo removes every line from the last capture', () => {
  let e2e: E2EService;

  beforeAll(async () => {
    e2e = await startE2E();
  });

  afterAll(async () => {
    await e2e.stop();
  });

  it('captures two items, then undo removes both and logs it', async () => {
    const captured = await e2e.mcp.callTool({
      name: 'capture',
      arguments: {
        items: [
          { kind: 'task', text: 'Order more coffee' },
          { kind: 'task', text: 'Schedule the car oil change' },
        ],
      },
    });
    const results = (captured.structuredContent as { results: StructuredCaptureItem[] }).results;
    const id1 = results[0]!.id!;
    const id2 = results[1]!.id!;

    let todo = await e2e.readVault('Tasks/To do.md');
    expect(todo).toContain(`Order more coffee ^${id1}`);
    expect(todo).toContain(`Schedule the car oil change ^${id2}`);

    const undone = await e2e.mcp.callTool({ name: 'update', arguments: { action: 'undo' } });
    expect(undone.isError).toBeFalsy();
    expect((undone.structuredContent as { status: string }).status).toBe('ok');

    todo = await e2e.readVault('Tasks/To do.md');
    expect(todo).not.toContain('Order more coffee');
    expect(todo).not.toContain('Schedule the car oil change');
    expect(todo).not.toContain(`^${id1}`);
    expect(todo).not.toContain(`^${id2}`);

    const log = await e2e.readVault('Log/2026-09-26.md');
    expect(log).toMatch(/· Claudia · undid \(2 items\)/);

    // Recall confirms they're gone from the index too, not just the file.
    const recalled = await e2e.mcp.callTool({ name: 'recall', arguments: { query: 'coffee' } });
    expect((recalled.structuredContent as { total: number }).total).toBe(0);
  });

  it('a second undo (nothing left to undo from this capture) reports there is nothing to undo', async () => {
    const undone = await e2e.mcp.callTool({ name: 'update', arguments: { action: 'undo' } });
    expect(undone.isError).toBeFalsy();
    expect((undone.structuredContent as { message: string }).message).toBe('Nothing to undo.');
  });
});
