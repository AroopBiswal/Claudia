import { describe, expect, it, vi } from 'vitest';
import { runCheck, type KVLike, type WatchdogState } from '../../../watchdog/src/check.ts';

const HEALTH_URL = 'https://claudia.example.com/health';
const ALERT_URL = 'https://ntfy.sh/claudia-watch-test-topic';

class InMemoryKV implements KVLike {
  private store = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.has(key) ? this.store.get(key)! : null);
  }

  put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

interface FakeCall {
  url: string;
  init: RequestInit | undefined;
}

interface FakeFetchOptions {
  /** Returns a Response, or throws/rejects to simulate a network error. */
  handleHealth?: () => Response | Promise<Response>;
  /** Returns a Response for the alert POST; defaults to 200 OK. */
  handleAlert?: () => Response | Promise<Response>;
  /** If true, the health fetch never resolves (used to exercise the timeout). */
  hangHealth?: boolean;
}

function makeFakeFetch(options: FakeFetchOptions = {}) {
  const calls: FakeCall[] = [];

  const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });

    if (url === HEALTH_URL) {
      if (options.hangHealth) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }
      const handler = options.handleHealth ?? (() => jsonResponse(200, { status: 'ok' }));
      return Promise.resolve(handler());
    }

    if (url === ALERT_URL) {
      const handler = options.handleAlert ?? (() => new Response('ok', { status: 200 }));
      return Promise.resolve(handler());
    }

    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

describe('runCheck', () => {
  it('stays healthy and never alerts on a run of ok checks', async () => {
    const kv = new InMemoryKV();
    const { fetchImpl, calls } = makeFakeFetch();

    const result = await runCheck({
      fetch: fetchImpl,
      kv,
      now: fixedClock('2026-09-26T10:00:00.000Z'),
      healthUrl: HEALTH_URL,
      alertTopicUrl: ALERT_URL,
    });

    expect(result.healthy).toBe(true);
    expect(result.alerted).toBeNull();
    expect(result.state.consecutiveFailures).toBe(0);
    expect(result.state.down).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(HEALTH_URL);
  });

  it('accepts a degraded status as healthy', async () => {
    const kv = new InMemoryKV();
    const { fetchImpl } = makeFakeFetch({
      handleHealth: () => jsonResponse(200, { status: 'degraded' }),
    });

    const result = await runCheck({
      fetch: fetchImpl,
      kv,
      now: fixedClock('2026-09-26T10:00:00.000Z'),
      healthUrl: HEALTH_URL,
      alertTopicUrl: ALERT_URL,
    });

    expect(result.healthy).toBe(true);
    expect(result.alerted).toBeNull();
  });

  it('runs the full down/recovery sequence with alerts only on the edges', async () => {
    const kv = new InMemoryKV();
    let healthy = true;
    const alertCalls: FakeCall[] = [];

    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url === HEALTH_URL) {
        return Promise.resolve(
          healthy ? jsonResponse(200, { status: 'ok' }) : jsonResponse(500, { status: 'down' }),
        );
      }
      if (url === ALERT_URL) {
        alertCalls.push({ url, init });
        return Promise.resolve(new Response('ok', { status: 200 }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const deps = {
      fetch: fetchImpl,
      kv,
      healthUrl: HEALTH_URL,
      alertTopicUrl: ALERT_URL,
    };

    // ok
    let result = await runCheck({ ...deps, now: fixedClock('2026-09-26T10:00:00.000Z') });
    expect(result.healthy).toBe(true);
    expect(result.alerted).toBeNull();

    // fail (1st) - no alert yet
    healthy = false;
    result = await runCheck({ ...deps, now: fixedClock('2026-09-26T10:05:00.000Z') });
    expect(result.healthy).toBe(false);
    expect(result.alerted).toBeNull();
    expect(result.state.consecutiveFailures).toBe(1);
    expect(result.state.down).toBe(false);
    expect(alertCalls).toHaveLength(0);

    // fail (2nd) - down alert fires
    result = await runCheck({ ...deps, now: fixedClock('2026-09-26T10:10:00.000Z') });
    expect(result.healthy).toBe(false);
    expect(result.alerted).toBe('down');
    expect(result.state.consecutiveFailures).toBe(2);
    expect(result.state.down).toBe(true);
    expect(result.state.since).toBe('2026-09-26T10:10:00.000Z');
    expect(alertCalls).toHaveLength(1);
    const downAlertInit = alertCalls[0]?.init;
    const downHeaders = downAlertInit?.headers as Record<string, string>;
    expect(downHeaders.Title).toBe('Claudia is down');
    expect(downHeaders.Priority).toBe('high');
    expect(downHeaders.Tags).toBe('warning');
    expect(downAlertInit?.body as string).toContain('down since 2026-09-26T10:10:00.000Z');

    // fail (3rd) - already down, no repeat alert
    result = await runCheck({ ...deps, now: fixedClock('2026-09-26T10:15:00.000Z') });
    expect(result.healthy).toBe(false);
    expect(result.alerted).toBeNull();
    expect(result.state.consecutiveFailures).toBe(3);
    expect(result.state.down).toBe(true);
    expect(alertCalls).toHaveLength(1);

    // ok - recovery alert fires
    healthy = true;
    result = await runCheck({ ...deps, now: fixedClock('2026-09-26T10:20:00.000Z') });
    expect(result.healthy).toBe(true);
    expect(result.alerted).toBe('recovered');
    expect(result.state.consecutiveFailures).toBe(0);
    expect(result.state.down).toBe(false);
    expect(result.state.since).toBeNull();
    expect(alertCalls).toHaveLength(2);
    const recoveryHeaders = alertCalls[1]?.init?.headers as Record<string, string>;
    expect(recoveryHeaders.Title).toBe('Claudia is back');
    expect(recoveryHeaders.Priority).toBe('default');
    expect(recoveryHeaders.Tags).toBeUndefined();

    // ok - nothing happens
    result = await runCheck({ ...deps, now: fixedClock('2026-09-26T10:25:00.000Z') });
    expect(result.healthy).toBe(true);
    expect(result.alerted).toBeNull();
    expect(alertCalls).toHaveLength(2);
  });

  it('counts a timeout as a failure', async () => {
    const kv = new InMemoryKV();
    const { fetchImpl } = makeFakeFetch({ hangHealth: true });

    const result = await runCheck({
      fetch: fetchImpl,
      kv,
      now: fixedClock('2026-09-26T10:00:00.000Z'),
      healthUrl: HEALTH_URL,
      alertTopicUrl: ALERT_URL,
      timeoutMs: 20,
    });

    expect(result.healthy).toBe(false);
    expect(result.state.consecutiveFailures).toBe(1);
    expect(result.state.lastError).toContain('timed out');
  });

  it('counts a non-200 response as a failure', async () => {
    const kv = new InMemoryKV();
    const { fetchImpl } = makeFakeFetch({
      handleHealth: () => jsonResponse(503, { status: 'ok' }),
    });

    const result = await runCheck({
      fetch: fetchImpl,
      kv,
      now: fixedClock('2026-09-26T10:00:00.000Z'),
      healthUrl: HEALTH_URL,
      alertTopicUrl: ALERT_URL,
    });

    expect(result.healthy).toBe(false);
    expect(result.state.lastError).toContain('503');
  });

  it('counts a non-JSON body as a failure', async () => {
    const kv = new InMemoryKV();
    const { fetchImpl } = makeFakeFetch({
      handleHealth: () => new Response('not json', { status: 200 }),
    });

    const result = await runCheck({
      fetch: fetchImpl,
      kv,
      now: fixedClock('2026-09-26T10:00:00.000Z'),
      healthUrl: HEALTH_URL,
      alertTopicUrl: ALERT_URL,
    });

    expect(result.healthy).toBe(false);
    expect(result.state.lastError).toContain('JSON');
  });

  it('counts a status of "down" in the JSON body as a failure', async () => {
    const kv = new InMemoryKV();
    const { fetchImpl } = makeFakeFetch({
      handleHealth: () => jsonResponse(200, { status: 'down' }),
    });

    const result = await runCheck({
      fetch: fetchImpl,
      kv,
      now: fixedClock('2026-09-26T10:00:00.000Z'),
      healthUrl: HEALTH_URL,
      alertTopicUrl: ALERT_URL,
    });

    expect(result.healthy).toBe(false);
    expect(result.state.lastError).toContain('down');
  });

  it('does not throw when the alert endpoint itself fails', async () => {
    const kv = new InMemoryKV();
    const state: WatchdogState = {
      consecutiveFailures: 1,
      down: false,
      since: null,
      lastCheck: '2026-09-26T09:55:00.000Z',
      lastError: 'unexpected HTTP status 500',
    };
    await kv.put('state', JSON.stringify(state));

    const { fetchImpl } = makeFakeFetch({
      handleHealth: () => jsonResponse(500, { status: 'down' }),
      handleAlert: () => {
        throw new Error('ntfy is unreachable');
      },
    });

    await expect(
      runCheck({
        fetch: fetchImpl,
        kv,
        now: fixedClock('2026-09-26T10:00:00.000Z'),
        healthUrl: HEALTH_URL,
        alertTopicUrl: ALERT_URL,
      }),
    ).resolves.toMatchObject({ healthy: false, alerted: 'down' });
  });

  it('sends the health request with no credentials', async () => {
    const kv = new InMemoryKV();
    const { fetchImpl, calls } = makeFakeFetch();

    await runCheck({
      fetch: fetchImpl,
      kv,
      now: fixedClock('2026-09-26T10:00:00.000Z'),
      healthUrl: HEALTH_URL,
      alertTopicUrl: ALERT_URL,
    });

    expect(calls[0]?.init?.credentials).toBe('omit');
  });
});
