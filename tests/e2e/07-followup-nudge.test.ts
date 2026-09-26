// E2E scenario 7: follow-up nudges (vault-format.md section 7, src/services/nudges.ts).
// A waiting-on follow-up with no ⏰ and no 📅 nudges once "Waiting-on nudge
// after" (default 5) days after its ➕ date, at the nudge time (default
// 09:00). Its "Tomorrow" push action sets 💤, which becomes the item's
// effective reminder (engine/index.ts computeEffectiveReminder), so from then
// on it fires through the ordinary reminder path instead of nudging again.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2E, type E2EService } from '../helpers/e2e-service.ts';

interface StructuredCaptureItem {
  index: number;
  status: string;
  id?: string;
  note?: string;
}

interface PushMessageLike {
  title?: string;
  message: string;
  click?: string;
  actions?: Array<{ label: string; url: string }>;
}

function messagesAfter(ntfy: E2EService['ntfy'], sinceIndex: number): PushMessageLike[] {
  return (ntfy.messages as unknown as PushMessageLike[]).slice(sinceIndex);
}

// 09:00 America/Los_Angeles is both the default nudge time and this vault's default
// brief-fallback moment (07:30 brief time + 90 minutes) -- a real, independent feature that may
// also push in this window. Filter to the titles this scenario cares about.
function titled(ntfy: E2EService['ntfy'], sinceIndex: number, title: string): PushMessageLike[] {
  return messagesAfter(ntfy, sinceIndex).filter((m) => m.title === title);
}

describe('e2e: follow-up nudge and its Tomorrow action', () => {
  let e2e: E2EService;
  let id: string;

  beforeAll(async () => {
    e2e = await startE2E();

    const result = await e2e.mcp.callTool({
      name: 'capture',
      arguments: {
        items: [
          {
            kind: 'follow_up',
            text: 'send the proposal',
            person: 'Alex Rivera',
            direction: 'waiting',
          },
        ],
      },
    });
    const item = (result.structuredContent as { results: StructuredCaptureItem[] }).results[0]!;
    expect(item.status).toBe('saved');
    id = item.id!;

    const followUps = await e2e.readVault('Tasks/Follow-ups.md');
    expect(followUps).toContain(
      `Waiting on [[Alex Rivera]]: send the proposal #waiting ➕ 2026-09-26`,
    );
    expect(followUps).toContain(`^${id}`);
  });

  afterAll(async () => {
    await e2e.stop();
  });

  it('does not nudge before 5 days have passed', async () => {
    e2e.clock.set('2026-09-30T16:00:00Z'); // Wed 09:00 America/Los_Angeles, 4 days after ➕
    await e2e.reauthorize();
    const baseline = e2e.ntfy.messages.length;
    const report = await e2e.tick();
    expect(report.nudged).not.toContain(id);
    expect(titled(e2e.ntfy, baseline, 'Follow-up')).toHaveLength(0);
  });

  let tomorrowUrl: string;

  it('sends a "Follow-up" push exactly 5 days after ➕, at the nudge time', async () => {
    e2e.clock.set('2026-10-01T16:00:00Z'); // Thu 09:00 America/Los_Angeles, 5 days after ➕
    const baseline = e2e.ntfy.messages.length;
    const report = await e2e.tick();
    expect(report.nudged).toContain(id);

    const pushes = titled(e2e.ntfy, baseline, 'Follow-up');
    expect(pushes).toHaveLength(1);
    const push = pushes[0]!;
    expect(push.message).toBe('Waiting on Alex Rivera: send the proposal');
    expect(push.actions!.map((a) => a.label)).toEqual(['Done', 'Tomorrow']);
    tomorrowUrl = push.actions!.find((a) => a.label === 'Tomorrow')!.url;

    // Doesn't nudge again on the next tick the same day.
    const before = e2e.ntfy.messages.length;
    await e2e.tick();
    expect(titled(e2e.ntfy, before, 'Follow-up')).toHaveLength(0);
  });

  it('its Tomorrow action sets 💤 to the next day at the nudge time', async () => {
    const res = await fetch(tomorrowUrl, { method: 'POST' });
    expect(res.status).toBe(200);

    const followUps = await e2e.readVault('Tasks/Follow-ups.md');
    // Canonical field order (vault-format.md 4.4) puts 💤 before ➕.
    expect(followUps).toContain(
      `Waiting on [[Alex Rivera]]: send the proposal #waiting 💤 2026-10-02 09:00 ➕ 2026-09-26 ^${id}`,
    );
  });

  it('fires the next day through the ordinary reminder path (the snooze is now its effective reminder)', async () => {
    e2e.clock.set('2026-10-02T15:59:00Z'); // Fri 08:59 America/Los_Angeles
    await e2e.reauthorize();
    let baseline = e2e.ntfy.messages.length;
    await e2e.tick();
    expect(titled(e2e.ntfy, baseline, 'Reminder')).toHaveLength(0);

    e2e.clock.set('2026-10-02T16:00:00Z'); // Fri 09:00 America/Los_Angeles
    baseline = e2e.ntfy.messages.length;
    const report = await e2e.tick();
    expect(report.fired).toContain(id);

    const pushes = titled(e2e.ntfy, baseline, 'Reminder');
    expect(pushes).toHaveLength(1);
    // Same plain-text rendering as the nudge push: no raw wikilink or tag syntax in the
    // notification body (vault-format.md 4.3; src/scheduler/scheduler.ts plainText()).
    expect(pushes[0]!.message).toBe('Waiting on Alex Rivera: send the proposal');
  });
});
