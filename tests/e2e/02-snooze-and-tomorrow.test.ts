// E2E scenario 2: the "+1 hour" and "Tomorrow" push-action links, driven
// through real HTTP against the live signed link, then re-fired by advancing
// the FakeClock past the new effective reminder.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2E, type E2EService } from '../helpers/e2e-service.ts';

interface StructuredCaptureItem {
  index: number;
  status: string;
  id?: string;
}

interface PushMessageLike {
  title?: string;
  message: string;
  actions?: Array<{ label: string; url: string }>;
}

function reminderPushesAfter(ntfy: E2EService['ntfy'], sinceIndex: number): PushMessageLike[] {
  return (ntfy.messages as unknown as PushMessageLike[])
    .slice(sinceIndex)
    .filter((m) => m.title === 'Reminder');
}

describe('e2e: snooze (+1 hour) and Tomorrow push actions', () => {
  let e2e: E2EService;

  beforeAll(async () => {
    e2e = await startE2E();
  });

  afterAll(async () => {
    await e2e.stop();
  });

  it('+1 hour snoozes the reminder by exactly one hour and it fires again then', async () => {
    const captured = await e2e.mcp.callTool({
      name: 'capture',
      arguments: {
        items: [{ kind: 'task', text: 'Take out recycling', remind_at: 'monday 10:00' }],
      },
    });
    const id = (captured.structuredContent as { results: StructuredCaptureItem[] }).results[0]!.id!;

    e2e.clock.set('2026-09-28T17:00:00Z'); // Mon 10:00 America/Los_Angeles
    await e2e.reauthorize();
    let before = e2e.ntfy.messages.length;
    await e2e.tick();
    let pushes = reminderPushesAfter(e2e.ntfy, before);
    expect(pushes).toHaveLength(1);
    const snooze = pushes[0]!.actions!.find((a) => a.label === '+1 hour')!;

    const res = await fetch(snooze.url, { method: 'POST' });
    expect(res.status).toBe(200);

    const todo = await e2e.readVault('Tasks/To do.md');
    expect(todo).toMatch(
      new RegExp(`Take out recycling ⏰ 2026-09-28 10:00 💤 2026-09-28 11:00 \\^${id}`),
    );

    // Not due yet: still 10:00, the snooze pushed it to 11:00.
    before = e2e.ntfy.messages.length;
    await e2e.tick();
    expect(reminderPushesAfter(e2e.ntfy, before)).toHaveLength(0);

    // Advance exactly to the snoozed time: fires again, once.
    e2e.clock.set('2026-09-28T18:00:00Z'); // Mon 11:00 America/Los_Angeles
    before = e2e.ntfy.messages.length;
    await e2e.tick();
    pushes = reminderPushesAfter(e2e.ntfy, before);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.message).toBe('Take out recycling');
  });

  it('Tomorrow snoozes to the same time of day the next day and it fires again then', async () => {
    // Continues from the previous test's clock position (Mon 2026-09-28 11:00 America/Los_Angeles):
    // real time never runs backwards here, just as it wouldn't on the real service.
    const captured = await e2e.mcp.callTool({
      name: 'capture',
      arguments: { items: [{ kind: 'task', text: 'Water the plants', remind_at: '+5m' }] },
    });
    const id = (captured.structuredContent as { results: StructuredCaptureItem[] }).results[0]!.id!;

    e2e.clock.advance(5 * 60_000); // Mon 11:05
    let before = e2e.ntfy.messages.length;
    await e2e.tick();
    let pushes = reminderPushesAfter(e2e.ntfy, before);
    expect(pushes).toHaveLength(1);
    const tomorrow = pushes[0]!.actions!.find((a) => a.label === 'Tomorrow')!;

    const res = await fetch(tomorrow.url, { method: 'POST' });
    expect(res.status).toBe(200);

    const todo = await e2e.readVault('Tasks/To do.md');
    expect(todo).toMatch(
      new RegExp(`Water the plants ⏰ 2026-09-28 11:05 💤 2026-09-29 11:05 \\^${id}`),
    );

    before = e2e.ntfy.messages.length;
    await e2e.tick();
    expect(reminderPushesAfter(e2e.ntfy, before)).toHaveLength(0);

    e2e.clock.advance(24 * 60 * 60_000); // Tue 11:05
    await e2e.reauthorize();
    before = e2e.ntfy.messages.length;
    await e2e.tick();
    pushes = reminderPushesAfter(e2e.ntfy, before);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.message).toBe('Water the plants');
  });
});
