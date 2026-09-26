import { describe, expect, it, vi } from 'vitest';
import worker, {
  type Env,
  type ExecutionContext,
  type ScheduledEvent,
} from '../../../watchdog/src/index.ts';
import type { KVLike } from '../../../watchdog/src/check.ts';

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

describe('watchdog worker', () => {
  it('fetch() returns a plain 200 without touching KV or the network', async () => {
    const response = await worker.fetch();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('claudia watchdog');
  });

  it('scheduled() runs the check through ctx.waitUntil', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url === 'https://claudia.example.com/health') {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);

    try {
      const env: Env = {
        STATE: new InMemoryKV(),
        HEALTH_URL: 'https://claudia.example.com/health',
        ALERT_TOPIC_URL: 'https://ntfy.sh/claudia-watch-test-topic',
      };
      const waited: Promise<unknown>[] = [];
      const ctx: ExecutionContext = {
        waitUntil: (promise) => {
          waited.push(promise);
        },
      };
      const event: ScheduledEvent = { cron: '*/5 * * * *', scheduledTime: Date.now() };

      worker.scheduled(event, env, ctx);

      expect(waited).toHaveLength(1);
      await waited[0];
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://claudia.example.com/health',
        expect.objectContaining({ method: 'GET', credentials: 'omit' }),
      );
      const stored = await env.STATE.get('state');
      expect(stored).not.toBeNull();
      const state = JSON.parse(stored ?? '{}') as { consecutiveFailures: number };
      expect(state.consecutiveFailures).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
