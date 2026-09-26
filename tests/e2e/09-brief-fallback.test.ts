// E2E scenario 9: the morning-brief fallback (src/scheduler/scheduler.ts
// runBriefFallback). When Claude never calls notify(kind: "brief") by the
// fallback moment (brief time + "Brief fallback after", default 07:30 + 90
// minutes = 09:00), the server sends its own brief push once. A day Claude
// did publish the brief (with a today_summary) gets no fallback, and
// Today.md carries that summary.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2E, type E2EService } from '../helpers/e2e-service.ts';

interface PushMessageLike {
  title?: string;
  message: string;
  click?: string;
}

function titled(ntfy: E2EService['ntfy'], sinceIndex: number, title: string): PushMessageLike[] {
  return (ntfy.messages as unknown as PushMessageLike[])
    .slice(sinceIndex)
    .filter((m) => m.title === title);
}

describe('e2e: brief fallback', () => {
  let e2e: E2EService;

  beforeAll(async () => {
    // Starts at Sat 2026-09-26 10:00 America/Los_Angeles: already inside the default fallback
    // window (09:00-15:00) with no brief published yet today.
    e2e = await startE2E();
  });

  afterAll(async () => {
    await e2e.stop();
  });

  it('sends the fallback push once when no brief was published by the fallback moment', async () => {
    let baseline = e2e.ntfy.messages.length;
    const report = await e2e.tick();
    expect(report.fallback).toBe(true);

    const pushes = titled(e2e.ntfy, baseline, 'Claudia brief');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.message).toBe('Nothing scheduled today.');
    expect(pushes[0]!.click).toBe('obsidian://open?vault=ClaudiaE2E&file=Today.md');

    baseline = e2e.ntfy.messages.length;
    const again = await e2e.tick();
    expect(again.fallback).toBe(false);
    expect(titled(e2e.ntfy, baseline, 'Claudia brief')).toHaveLength(0);
  });

  it('does not fall back on a day Claude published the brief with a summary, and Today.md gets it', async () => {
    e2e.clock.set('2026-09-27T14:31:00Z'); // Sun 07:31 America/Los_Angeles: brief time + 1 minute
    await e2e.reauthorize();

    const notifyResult = await e2e.mcp.callTool({
      name: 'notify',
      arguments: {
        message: '2 things today.',
        kind: 'brief',
        today_summary: 'Dentist at 3pm; call mom.',
      },
    });
    expect((notifyResult.structuredContent as { status: string }).status).toBe('sent');

    e2e.clock.set('2026-09-27T16:00:00Z'); // Sun 09:00: this day's fallback moment
    const baseline = e2e.ntfy.messages.length;
    const report = await e2e.tick();
    expect(report.fallback).toBe(false);
    expect(titled(e2e.ntfy, baseline, 'Claudia brief')).toHaveLength(0);

    const today = await e2e.readVault('Today.md');
    expect(today).toContain('Dentist at 3pm; call mom.');
  });
});
