// E2E scenario 3: a weekly repeating reminder fires, completing it inserts
// the next occurrence with a new block id and a shifted ⏰, that occurrence
// fires the following week, and the same holds true across the US
// fall-back DST transition (2026-11-01), since every vault time is a local
// wall-clock time with no stored offset (vault-format.md section 7).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localToInstant } from '../../src/time/format.ts';
import { startE2E, type E2EService } from '../helpers/e2e-service.ts';

const ZONE = 'America/Los_Angeles';

interface StructuredCaptureItem {
  index: number;
  status: string;
  id?: string;
}

interface RecallResult {
  id: string;
  text: string;
  reminder: string | null;
  repeat: string | null;
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

/** Sets the FakeClock to the instant that local wall time denotes in ZONE, and reauthorizes. */
async function jumpTo(e2e: E2EService, local: string): Promise<void> {
  e2e.clock.set(localToInstant(local, ZONE));
  await e2e.reauthorize();
}

async function openLaundryId(e2e: E2EService): Promise<string> {
  const result = await e2e.mcp.callTool({
    name: 'recall',
    arguments: { query: 'Laundry', kinds: ['task'] },
  });
  const results = (result.structuredContent as { results: RecallResult[] }).results;
  const open = results.find((r) => r.text === 'Laundry');
  if (!open) throw new Error(`no open "Laundry" item found among: ${JSON.stringify(results)}`);
  return open.id;
}

describe('e2e: weekly repeat and DST', () => {
  let e2e: E2EService;

  beforeAll(async () => {
    e2e = await startE2E();
  });

  afterAll(async () => {
    await e2e.stop();
  });

  it('captures the weekly Sunday reminder with the documented line shape', async () => {
    const result = await e2e.mcp.callTool({
      name: 'capture',
      arguments: {
        items: [
          {
            kind: 'task',
            text: 'Laundry',
            remind_at: 'sunday 19:00',
            repeat: 'every week on Sunday',
          },
        ],
      },
    });
    const id = (result.structuredContent as { results: StructuredCaptureItem[] }).results[0]!.id!;
    const todo = await e2e.readVault('Tasks/To do.md');
    expect(todo).toContain(`- [ ] Laundry ⏰ 2026-09-27 19:00 🔁 every week on Sunday ^${id}`);
  });

  it('fires the first Sunday, and completing it inserts next Sunday above with a new id', async () => {
    await jumpTo(e2e, '2026-09-27 19:00');
    let before = e2e.ntfy.messages.length;
    await e2e.tick();
    expect(reminderPushesAfter(e2e.ntfy, before)).toHaveLength(1);

    const firstId = await openLaundryId(e2e);
    const completed = await e2e.mcp.callTool({
      name: 'update',
      arguments: { action: 'complete', id: firstId },
    });
    expect(completed.isError).toBeFalsy();

    const todo = await e2e.readVault('Tasks/To do.md');
    // The completed line keeps its id and gets ✅; the new occurrence is inserted directly above
    // it (vault-format.md section 7) with a fresh id and ⏰ shifted exactly one week.
    expect(todo).toMatch(
      new RegExp(
        `- \\[ \\] Laundry ⏰ 2026-10-04 19:00 🔁 every week on Sunday \\^[a-z0-9]{4,}\\n` +
          `- \\[x\\] Laundry ⏰ 2026-09-27 19:00 🔁 every week on Sunday ✅ 2026-09-27 \\^${firstId}`,
      ),
    );

    const secondId = await openLaundryId(e2e);
    expect(secondId).not.toBe(firstId);

    // Not due yet.
    before = e2e.ntfy.messages.length;
    await e2e.tick();
    expect(reminderPushesAfter(e2e.ntfy, before)).toHaveLength(0);

    await jumpTo(e2e, '2026-10-04 19:00');
    before = e2e.ntfy.messages.length;
    await e2e.tick();
    const pushes = reminderPushesAfter(e2e.ntfy, before);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.message).toBe('Laundry');
  });

  it('keeps firing at 19:00 local across the fall-back DST transition (2026-11-01)', async () => {
    const beforeDstOffsetMs =
      localToInstant('2026-10-25 19:00', ZONE).getTime() - Date.parse('2026-10-25T19:00:00Z');
    const afterDstOffsetMs =
      localToInstant('2026-11-01 19:00', ZONE).getTime() - Date.parse('2026-11-01T19:00:00Z');
    expect(beforeDstOffsetMs).not.toBe(afterDstOffsetMs); // sanity: the fixture really does cross DST

    // Currently open at 2026-10-04 (left that way by the previous test, which fired but did not
    // complete it). Each completion below shifts the anchor exactly one week regardless of when
    // it's clicked, so four completions walk 10-04 -> 10-11 -> 10-18 -> 10-25 -> 11-01.
    for (const sunday of ['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01']) {
      await jumpTo(e2e, `${sunday} 19:00`);
      const id = await openLaundryId(e2e);
      const completed = await e2e.mcp.callTool({
        name: 'update',
        arguments: { action: 'complete', id },
      });
      expect(completed.isError).toBeFalsy();
    }

    const todo = await e2e.readVault('Tasks/To do.md');
    expect(todo).toContain('Laundry ⏰ 2026-11-01 19:00 🔁 every week on Sunday');

    await jumpTo(e2e, '2026-11-01 18:59');
    let before = e2e.ntfy.messages.length;
    await e2e.tick();
    expect(reminderPushesAfter(e2e.ntfy, before)).toHaveLength(0);

    await jumpTo(e2e, '2026-11-01 19:00');
    before = e2e.ntfy.messages.length;
    await e2e.tick();
    const pushes = reminderPushesAfter(e2e.ntfy, before);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.message).toBe('Laundry');
  });
});
