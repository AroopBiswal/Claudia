// E2E scenario 4: the owner editing files directly in Obsidian (not through
// the MCP tools). The vault file watcher (real fs.watch, on by default) must
// pick up a hand-written task line, assign it a block id, and reschedule an
// existing reminder when its ⏰ field is hand-edited.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2E, waitFor, type E2EService } from '../helpers/e2e-service.ts';

interface StructuredCaptureItem {
  index: number;
  status: string;
  id?: string;
}

interface PushMessageLike {
  title?: string;
  message: string;
}

function reminderPushesAfter(ntfy: E2EService['ntfy'], sinceIndex: number): PushMessageLike[] {
  return (ntfy.messages as unknown as PushMessageLike[])
    .slice(sinceIndex)
    .filter((m) => m.title === 'Reminder');
}

describe('e2e: hand edits in Obsidian are picked up by the watcher', () => {
  let e2e: E2EService;

  beforeAll(async () => {
    e2e = await startE2E();
  });

  afterAll(async () => {
    await e2e.stop();
  });

  it('assigns a block id to a hand-written task line with ⏰, and it fires at its time', async () => {
    const before = await e2e.readVault('Tasks/To do.md');
    const withoutTrailingNl = before.endsWith('\n') ? before : `${before}\n`;
    await e2e.writeVault(
      'Tasks/To do.md',
      `${withoutTrailingNl}- [ ] Pick up dry cleaning ⏰ 2026-09-30 14:00\n`,
    );

    const idMatch = await waitFor<RegExpExecArray>(
      async () => {
        const text = await e2e.readVault('Tasks/To do.md');
        return /Pick up dry cleaning ⏰ 2026-09-30 14:00 \^(t[a-z0-9]{4})/.exec(text) ?? undefined;
      },
      { timeoutMs: 3000, message: 'watcher never assigned a block id to the hand-written line' },
    );
    const id = idMatch[1]!;

    e2e.clock.set('2026-09-30T20:59:00Z'); // Wed 13:59 America/Los_Angeles
    await e2e.reauthorize();
    let baseline = e2e.ntfy.messages.length;
    await e2e.tick();
    expect(reminderPushesAfter(e2e.ntfy, baseline)).toHaveLength(0);

    e2e.clock.set('2026-09-30T21:00:00Z'); // Wed 14:00 America/Los_Angeles
    baseline = e2e.ntfy.messages.length;
    await e2e.tick();
    const pushes = reminderPushesAfter(e2e.ntfy, baseline);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.message).toBe('Pick up dry cleaning');

    // recall confirms the index (not just the raw file) knows about it under this id.
    const recalled = await e2e.mcp.callTool({
      name: 'recall',
      arguments: { query: 'dry cleaning' },
    });
    const found = (recalled.structuredContent as { results: Array<{ id: string }> }).results.find(
      (r) => r.id === id,
    );
    expect(found).toBeDefined();
  });

  it('reschedules to a hand-edited ⏰ and fires at the new time, not the old one', async () => {
    const captured = await e2e.mcp.callTool({
      name: 'capture',
      arguments: {
        items: [{ kind: 'task', text: 'Renew library book', remind_at: 'thursday 12:00' }],
      },
    });
    const id = (captured.structuredContent as { results: StructuredCaptureItem[] }).results[0]!.id!;

    // The owner opens To do.md in Obsidian and retimes it by hand, in place, well before it's due.
    const before = await e2e.readVault('Tasks/To do.md');
    expect(before).toContain(`Renew library book ⏰ 2026-10-01 12:00 ^${id}`);
    const edited = before.replace(
      `Renew library book ⏰ 2026-10-01 12:00 ^${id}`,
      `Renew library book ⏰ 2026-10-01 17:00 ^${id}`,
    );
    await e2e.writeVault('Tasks/To do.md', edited);

    await waitFor(
      async () => {
        const result = await e2e.mcp.callTool({
          name: 'recall',
          arguments: { query: 'library book' },
        });
        const item = (
          result.structuredContent as { results: Array<{ id: string; reminder: string | null }> }
        ).results.find((r) => r.id === id);
        return item?.reminder === '2026-10-01 17:00';
      },
      { timeoutMs: 3000, message: 'watcher never picked up the hand-edited ⏰ field' },
    );

    // The old time (12:00) must not fire it.
    e2e.clock.set('2026-10-01T19:00:00Z'); // Thu 12:00 America/Los_Angeles
    await e2e.reauthorize();
    let baseline = e2e.ntfy.messages.length;
    await e2e.tick();
    expect(reminderPushesAfter(e2e.ntfy, baseline)).toHaveLength(0);

    // The new time (17:00) does.
    e2e.clock.set('2026-10-02T00:00:00Z'); // Thu 17:00 America/Los_Angeles
    baseline = e2e.ntfy.messages.length;
    await e2e.tick();
    const pushes = reminderPushesAfter(e2e.ntfy, baseline);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.message).toBe('Renew library book');
  });
});
