import { runCheck, type KVLike } from './check.ts';

// Minimal local stand-ins for the Workers runtime types we need. We are not
// allowed to add the @cloudflare/workers-types dependency, so we declare the
// small slice of the surface this worker actually touches.
export interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  STATE: KVLike;
  HEALTH_URL: string;
  ALERT_TOPIC_URL: string;
}

export default {
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      runCheck({
        fetch: globalThis.fetch,
        kv: env.STATE,
        now: () => new Date(),
        healthUrl: env.HEALTH_URL,
        alertTopicUrl: env.ALERT_TOPIC_URL,
      }),
    );
  },

  // eslint-disable-next-line @typescript-eslint/require-await -- keeps the Workers fetch handler signature async
  async fetch(): Promise<Response> {
    return new Response('claudia watchdog', { status: 200 });
  },
};
