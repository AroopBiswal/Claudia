import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { bundlePush, createNtfyNotifier, reminderPush } from '../../../src/notify/ntfy.ts';
import { verifyActionLink } from '../../../src/notify/links.ts';
import { startFakeNtfy } from '../../helpers/fake-ntfy.ts';

const KEY = Buffer.from('c'.repeat(32), 'utf8');
const NOW = new Date('2026-09-26T18:00:00Z');

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

describe('createNtfyNotifier', () => {
  it('publishes the expected request shape with no auth header when no token is set', async () => {
    const fake = await startFakeNtfy();
    cleanup = () => fake.close();

    const notifier = createNtfyNotifier({ baseUrl: fake.url, topic: 'claudia-test' });
    const result = await notifier.send({
      title: 'Reminder',
      message: 'Call the dentist',
      priority: 'high',
      tags: ['alarm_clock'],
      click: 'obsidian://open?vault=Claudia&file=To%20do.md',
      actions: [
        { label: 'Done', url: 'https://x.example.com/a/tok1', method: 'POST', clear: true },
        { label: '+1 hour', url: 'https://x.example.com/a/tok2', method: 'POST', clear: true },
        { label: 'Tomorrow', url: 'https://x.example.com/a/tok3', method: 'POST', clear: true },
      ],
    });

    expect(result.ok).toBe(true);
    expect(fake.messages).toHaveLength(1);
    const published = fake.messages[0]!;
    expect(published.topic).toBe('claudia-test');
    expect(published.title).toBe('Reminder');
    expect(published.message).toBe('Call the dentist');
    expect(published.priority).toBe(4);
    expect(published.tags).toEqual(['alarm_clock']);
    expect(published.click).toBe('obsidian://open?vault=Claudia&file=To%20do.md');
    expect(published.actions).toEqual([
      {
        action: 'http',
        label: 'Done',
        url: 'https://x.example.com/a/tok1',
        method: 'POST',
        clear: true,
      },
      {
        action: 'http',
        label: '+1 hour',
        url: 'https://x.example.com/a/tok2',
        method: 'POST',
        clear: true,
      },
      {
        action: 'http',
        label: 'Tomorrow',
        url: 'https://x.example.com/a/tok3',
        method: 'POST',
        clear: true,
      },
    ]);
  });

  it('maps every priority name to its ntfy number', async () => {
    const fake = await startFakeNtfy();
    cleanup = () => fake.close();
    const notifier = createNtfyNotifier({ baseUrl: fake.url, topic: 'p' });

    const expected: Record<string, number> = {
      min: 1,
      low: 2,
      default: 3,
      high: 4,
      urgent: 5,
    };

    for (const [priority, num] of Object.entries(expected)) {
      await notifier.send({ message: 'x', priority: priority as never });
      expect(fake.messages.at(-1)?.priority).toBe(num);
    }
  });

  it('sends an Authorization header only when a token is configured', async () => {
    const fake = await startFakeNtfy({ token: 'secret-token' });
    cleanup = () => fake.close();

    const withToken = createNtfyNotifier({
      baseUrl: fake.url,
      topic: 'auth-test',
      token: 'secret-token',
    });
    const okResult = await withToken.send({ message: 'hello' });
    expect(okResult).toEqual({ ok: true, id: fake.messages[0]?.id });

    const withoutToken = createNtfyNotifier({ baseUrl: fake.url, topic: 'auth-test' });
    const failResult = await withoutToken.send({ message: 'hello again' });
    expect(failResult.ok).toBe(false);
    if (!failResult.ok) {
      expect(failResult.error).not.toContain('secret-token');
    }
  });

  it('throws when given more than 3 actions', async () => {
    const fake = await startFakeNtfy();
    cleanup = () => fake.close();
    const notifier = createNtfyNotifier({ baseUrl: fake.url, topic: 't' });

    await expect(
      notifier.send({
        message: 'x',
        actions: [
          { label: 'a', url: 'https://e.com/a' },
          { label: 'b', url: 'https://e.com/b' },
          { label: 'c', url: 'https://e.com/c' },
          { label: 'd', url: 'https://e.com/d' },
        ],
      }),
    ).rejects.toThrow(/at most 3 actions/);
  });

  it('returns ok:false without throwing on a request timeout', async () => {
    const hangingFetch = (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation timed out', 'TimeoutError'));
        });
      });
    }) as typeof fetch;

    const notifier = createNtfyNotifier({
      baseUrl: 'http://127.0.0.1:1',
      topic: 't',
      fetch: hangingFetch,
      timeoutMs: 10,
    });

    const result = await notifier.send({ message: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('timed out');
    }
  });

  it('returns ok:false on HTTP 401 without leaking the token', async () => {
    const fake = await startFakeNtfy({ token: 'super-secret' });
    cleanup = () => fake.close();

    const notifier = createNtfyNotifier({
      baseUrl: fake.url,
      topic: 't',
      token: 'wrong-token',
    });
    const result = await notifier.send({ message: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('super-secret');
      expect(result.error).not.toContain('wrong-token');
      expect(result.error).toContain('401');
    }
  });

  it('returns ok:false on HTTP 500 without leaking the token', async () => {
    let server: Server;
    await new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 500, error: 'boom' }));
      });
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server!.address();
    if (address === null || typeof address === 'string') throw new Error('bind failed');
    const url = `http://127.0.0.1:${address.port}`;
    cleanup = () =>
      new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));

    const notifier = createNtfyNotifier({ baseUrl: url, topic: 't', token: 'my-token-value' });
    const result = await notifier.send({ message: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('my-token-value');
      expect(result.error).toContain('500');
    }
  });
});

describe('reminderPush', () => {
  it('builds a reminder push with signed action links and an encoded obsidian click url', () => {
    const msg = reminderPush({
      id: 't9x2k',
      text: 'Call the dentist',
      notePath: 'Tasks/To do.md',
      fireLocal: '2026-09-29 09:00',
      vaultName: 'Claudia',
      publicUrl: 'https://claudia.example.com',
      key: KEY,
      now: NOW,
    });

    expect(msg.title).toBe('Reminder');
    expect(msg.message).toBe('Call the dentist');
    expect(msg.priority).toBe('high');
    expect(msg.tags).toEqual(['alarm_clock']);
    expect(msg.click).toBe(
      'obsidian://open?vault=Claudia&file=' + encodeURIComponent('Tasks/To do.md#^t9x2k'),
    );
    // spaces and #^ must be percent-encoded
    expect(msg.click).toContain('Tasks%2FTo%20do.md%23%5Et9x2k');

    expect(msg.actions).toHaveLength(3);
    const [done, snooze, tomorrow] = msg.actions!;
    expect(done!.label).toBe('Done');
    expect(snooze!.label).toBe('+1 hour');
    expect(tomorrow!.label).toBe('Tomorrow');
    for (const action of msg.actions!) {
      expect(action.method).toBe('POST');
      expect(action.clear).toBe(true);
    }

    const doneToken = done!.url.split('/a/')[1]!;
    const verified = verifyActionLink(KEY, doneToken, { now: NOW });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.a).toBe('done');
      expect(verified.payload.id).toBe('t9x2k');
    }

    const snoozeToken = snooze!.url.split('/a/')[1]!;
    const verifiedSnooze = verifyActionLink(KEY, snoozeToken, { now: NOW });
    expect(verifiedSnooze.ok).toBe(true);
    if (verifiedSnooze.ok) expect(verifiedSnooze.payload.a).toBe('snooze1h');

    const tomorrowToken = tomorrow!.url.split('/a/')[1]!;
    const verifiedTomorrow = verifyActionLink(KEY, tomorrowToken, { now: NOW });
    expect(verifiedTomorrow.ok).toBe(true);
    if (verifiedTomorrow.ok) expect(verifiedTomorrow.payload.a).toBe('tomorrow');
  });

  it('marks late reminders with a different title and due time in the message', () => {
    const msg = reminderPush({
      id: 't1',
      text: 'Water the plants',
      notePath: 'To do.md',
      fireLocal: '2026-09-26 08:00',
      vaultName: 'Claudia',
      publicUrl: 'https://claudia.example.com',
      key: KEY,
      now: NOW,
      late: true,
    });

    expect(msg.title).toBe('Reminder (late)');
    expect(msg.message).toBe('Water the plants — was due 2026-09-26 08:00');
  });
});

describe('bundlePush', () => {
  it('builds a summary push with no actions that opens Today.md', () => {
    const msg = bundlePush({
      items: [
        { id: 't1', text: 'Call the dentist', fireLocal: '2026-09-26 09:00' },
        { id: 't2', text: 'Water the plants', fireLocal: '2026-09-26 10:00' },
      ],
      vaultName: 'Claudia',
    });

    expect(msg.title).toBe('While I was offline');
    expect(msg.actions).toBeUndefined();
    expect(msg.message).toContain('Call the dentist');
    expect(msg.message).toContain('Water the plants');
    expect(msg.click).toBe('obsidian://open?vault=Claudia&file=Today.md');
  });

  it('opens a custom note path when given one', () => {
    const msg = bundlePush({
      items: [{ id: 't1', text: 'Call the dentist', fireLocal: '2026-09-26 09:00' }],
      vaultName: 'Claudia',
      notePath: 'Daily/2026-09-26.md',
    });

    expect(msg.click).toBe(
      'obsidian://open?vault=Claudia&file=' + encodeURIComponent('Daily/2026-09-26.md'),
    );
  });
});
