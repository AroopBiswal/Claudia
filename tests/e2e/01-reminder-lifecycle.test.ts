// E2E scenario 1 (docs/KICKOFF.md "Testing bar: End to end"): capture a timed
// reminder over real MCP/HTTP, see it land in the vault, index and Log, then
// drive the FakeClock through its fire time and complete it through the
// signed /a/<token> push-action link exactly as a phone would.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2E, waitFor, type E2EService } from '../helpers/e2e-service.ts';

interface StructuredCaptureItem {
  index: number;
  status: string;
  kind: string;
  id?: string;
  reason?: string;
}

interface PushMessageLike {
  title?: string;
  message: string;
  topic?: string;
  click?: string;
  actions?: Array<{ label: string; url: string; method?: string; clear?: boolean }>;
}

describe('e2e: reminder lifecycle', () => {
  let e2e: E2EService;
  let taskId: string;

  beforeAll(async () => {
    e2e = await startE2E();
  });

  afterAll(async () => {
    await e2e.stop();
  });

  it('captures a timed reminder with the documented receipt', async () => {
    const result = await e2e.mcp.callTool({
      name: 'capture',
      arguments: {
        items: [{ kind: 'task', text: 'Call the dentist', remind_at: 'tuesday 09:00' }],
      },
    });
    expect(result.isError).toBeFalsy();

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toBe('Reminder set: Tue 9:00am.');

    const structured = result.structuredContent as {
      receipt?: string;
      results: StructuredCaptureItem[];
    };
    expect(structured.receipt).toBe('Reminder set: Tue 9:00am.');
    expect(structured.results).toHaveLength(1);
    expect(structured.results[0]!.status).toBe('saved');
    taskId = structured.results[0]!.id!;
    expect(taskId).toMatch(/^t[a-z0-9]{4}$/);
  });

  it('writes the exact task line to Tasks/To do.md', async () => {
    const todo = await e2e.readVault('Tasks/To do.md');
    expect(todo).toContain(`- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^${taskId}`);
  });

  it('is findable through recall', async () => {
    const result = await e2e.mcp.callTool({ name: 'recall', arguments: { query: 'dentist' } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { results: Array<{ id: string }> };
    expect(structured.results.some((r) => r.id === taskId)).toBe(true);
  });

  it('appends a Log line for the capture', async () => {
    const log = await e2e.readVault('Log/2026-09-26.md');
    expect(log).toContain(`added [[To do#^${taskId}|Call the dentist]]`);
  });

  it('lists it in Recently captured.md once the debounced generated-notes refresh runs', async () => {
    await waitFor(
      async () => {
        const recent = await e2e.readVault('Recently captured.md');
        return recent.includes(`[[To do#^${taskId}|Call the dentist]]`);
      },
      { timeoutMs: 5000, message: 'Recently captured.md was never refreshed with the new capture' },
    );
  });

  // Tuesday 09:00 is also this vault's default brief-fallback moment (07:30 brief time + 90
  // minutes), a real, independent feature that may push its own message in this window. Filter
  // to "Reminder"-titled pushes so that doesn't confuse the counts below.
  function reminderPushes(): PushMessageLike[] {
    return (e2e.ntfy.messages as unknown as PushMessageLike[]).filter(
      (m) => m.title === 'Reminder',
    );
  }

  it('does not fire before the reminder time', async () => {
    e2e.clock.set('2026-09-29T15:59:00Z'); // Tue 08:59 America/Los_Angeles
    await e2e.reauthorize(); // the access token minted on Saturday has since expired
    const report = await e2e.tick();
    expect(report.fired).not.toContain(taskId);
    expect(reminderPushes()).toHaveLength(0);
  });

  it('fires exactly one ntfy push with Done / +1 hour / Tomorrow actions at 09:00', async () => {
    e2e.clock.set('2026-09-29T16:00:00Z'); // Tue 09:00 America/Los_Angeles
    const report = await e2e.tick();
    expect(report.fired).toContain(taskId);
    expect(reminderPushes()).toHaveLength(1);

    const msg = reminderPushes()[0]!;
    expect(msg.message).toBe('Call the dentist');
    expect(msg.click).toBe(
      `obsidian://open?vault=ClaudiaE2E&file=Tasks%2FTo%20do.md%23%5E${taskId}`,
    );
    expect(msg.actions).toHaveLength(3);
    const labels = msg.actions!.map((a) => a.label);
    expect(labels).toEqual(['Done', '+1 hour', 'Tomorrow']);
    for (const action of msg.actions!) {
      expect(action.url.startsWith(`${e2e.url}/a/`)).toBe(true);
      expect(action.method).toBe('POST');
    }
  });

  it('does not fire a duplicate on a second tick', async () => {
    const report = await e2e.tick();
    expect(report.fired).not.toContain(taskId);
    expect(reminderPushes()).toHaveLength(1);
  });

  let doneUrl: string;

  it('completing the Done action link returns 200 and marks the vault line done', async () => {
    const msg = reminderPushes()[0]!;
    const done = msg.actions!.find((a) => a.label === 'Done')!;
    // The link was signed with e2e.url as publicUrl (matches the fake server we're posting to).
    doneUrl = done.url;
    expect(doneUrl.startsWith(`${e2e.url}/a/`)).toBe(true);

    const res = await fetch(doneUrl, { method: 'POST' });
    expect(res.status).toBe(200);

    const todo = await e2e.readVault('Tasks/To do.md');
    expect(todo).toMatch(
      new RegExp(`- \\[x\\] Call the dentist ⏰ 2026-09-29 09:00 ✅ 2026-09-29 \\^${taskId}`),
    );
  });

  it('completing the same Done link again returns 410 (single use)', async () => {
    const res = await fetch(doneUrl, { method: 'POST' });
    expect(res.status).toBe(410);
  });
});
