// E2E scenario 5: downtime catch-up (src/scheduler/scheduler.ts runReminders,
// CATCHUP_WINDOW_MS = 2 hours). Reminders that come due while the service
// isn't ticking and are still within the last 2 hours when it resumes are
// sent individually (marked late); older ones are bundled into one "While I
// was offline" push. Nothing repeats on the next tick.

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
}

function messagesAfter(ntfy: E2EService['ntfy'], sinceIndex: number): PushMessageLike[] {
  return (ntfy.messages as unknown as PushMessageLike[]).slice(sinceIndex);
}

describe('e2e: downtime catch-up (individual late sends + one bundle)', () => {
  let e2e: E2EService;
  let recentIds: string[]; // +1h, +2h: bundled (older than the 2h catch-up window once we jump 31h)
  let lateIds: string[]; // +29h, +30h: within the 2h catch-up window, sent individually

  beforeAll(async () => {
    e2e = await startE2E();

    const result = await e2e.mcp.callTool({
      name: 'capture',
      arguments: {
        items: [
          { kind: 'task', text: 'Morning stretch', remind_at: '+1h' },
          { kind: 'task', text: 'Check the mail', remind_at: '+2h' },
          { kind: 'task', text: 'Water the garden', remind_at: '+29h' },
          { kind: 'task', text: 'Feed the cat', remind_at: '+30h' },
        ],
      },
    });
    const results = (result.structuredContent as { results: StructuredCaptureItem[] }).results;
    recentIds = [results[0]!.id!, results[1]!.id!];
    lateIds = [results[2]!.id!, results[3]!.id!];
  });

  afterAll(async () => {
    await e2e.stop();
  });

  it('never ticks during the "outage": no pushes are sent yet', () => {
    expect(e2e.ntfy.messages).toHaveLength(0);
  });

  it('one catch-up tick after 31 hours sends the two recent ones individually (late) and bundles the rest', async () => {
    const baseline = e2e.ntfy.messages.length;
    e2e.clock.advance(31 * 60 * 60_000);

    const report = await e2e.tick();

    expect(report.fired.sort()).toEqual([...lateIds].sort());
    expect(report.bundled.sort()).toEqual([...recentIds].sort());

    const pushes = messagesAfter(e2e.ntfy, baseline);
    const individual = pushes.filter((m) => m.title === 'Reminder (late)');
    const bundles = pushes.filter((m) => m.title === 'While I was offline');

    expect(individual).toHaveLength(2);
    const individualTexts = individual.map((m) => m.message).sort();
    expect(individualTexts).toEqual([
      'Feed the cat — was due 2026-09-27 16:00',
      'Water the garden — was due 2026-09-27 15:00',
    ]);

    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.message).toBe(
      '2026-09-26 11:00 — Morning stretch\n2026-09-26 12:00 — Check the mail',
    );

    expect(pushes).toHaveLength(3);
  });

  it('does not repeat any of them on the next tick', async () => {
    const baseline = e2e.ntfy.messages.length;
    const report = await e2e.tick();
    expect(report.fired).toHaveLength(0);
    expect(report.bundled).toHaveLength(0);
    expect(messagesAfter(e2e.ntfy, baseline)).toHaveLength(0);
  });
});
