import { actionUrl, signActionLink } from './links.ts';

export type Priority = 'min' | 'low' | 'default' | 'high' | 'urgent';

export interface PushAction {
  label: string;
  url: string;
  method?: 'POST' | 'GET';
  clear?: boolean;
}

export interface PushMessage {
  title?: string;
  message: string;
  priority?: Priority;
  tags?: string[];
  click?: string;
  actions?: PushAction[];
}

export type SendResult = { ok: true; id: string | null } | { ok: false; error: string };

export interface Notifier {
  send(msg: PushMessage): Promise<SendResult>;
}

const PRIORITY_MAP: Record<Priority, number> = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  urgent: 5,
};

const MAX_ACTIONS = 3;
const DEFAULT_TIMEOUT_MS = 10000;

function redact(message: string, token: string | null | undefined): string {
  if (!token) return message;
  return message.split(token).join('[redacted]');
}

function describeError(err: unknown, token: string | null | undefined): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return 'request timed out';
    }
    return redact(err.message, token);
  }
  return redact(String(err), token);
}

export function createNtfyNotifier(opts: {
  baseUrl: string;
  topic: string;
  token?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Notifier {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl.slice(0, -1) : opts.baseUrl;
  const token = opts.token ?? null;

  return {
    async send(msg: PushMessage): Promise<SendResult> {
      if (msg.actions && msg.actions.length > MAX_ACTIONS) {
        throw new Error(`ntfy supports at most ${MAX_ACTIONS} actions`);
      }

      const body: Record<string, unknown> = {
        topic: opts.topic,
        message: msg.message,
      };
      if (msg.title !== undefined) body.title = msg.title;
      if (msg.priority !== undefined) body.priority = PRIORITY_MAP[msg.priority];
      if (msg.tags !== undefined) body.tags = msg.tags;
      if (msg.click !== undefined) body.click = msg.click;
      if (msg.actions !== undefined) {
        body.actions = msg.actions.map((action) => ({
          action: 'http',
          label: action.label,
          url: action.url,
          method: action.method ?? 'POST',
          clear: action.clear ?? false,
        }));
      }

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token) {
        headers.authorization = `Bearer ${token}`;
      }

      try {
        const res = await doFetch(baseUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          return { ok: false, error: `ntfy responded with ${res.status}` };
        }

        const data = (await res.json()) as { id?: string | null };
        return { ok: true, id: data.id ?? null };
      } catch (err) {
        return { ok: false, error: describeError(err, token) };
      }
    },
  };
}

export function reminderPush(opts: {
  id: string;
  text: string;
  notePath: string;
  fireLocal: string;
  vaultName: string;
  publicUrl: string;
  key: Buffer;
  now: Date;
  late?: boolean;
}): PushMessage {
  const title = opts.late ? 'Reminder (late)' : 'Reminder';
  const message = opts.text + (opts.late ? ` — was due ${opts.fireLocal}` : '');
  const click = `obsidian://open?vault=${opts.vaultName}&file=${encodeURIComponent(
    `${opts.notePath}#^${opts.id}`,
  )}`;

  const doneToken = signActionLink(opts.key, { action: 'done', id: opts.id, now: opts.now });
  const snoozeToken = signActionLink(opts.key, {
    action: 'snooze1h',
    id: opts.id,
    now: opts.now,
  });
  const tomorrowToken = signActionLink(opts.key, {
    action: 'tomorrow',
    id: opts.id,
    now: opts.now,
  });

  return {
    title,
    message,
    priority: 'high',
    tags: ['alarm_clock'],
    click,
    actions: [
      { label: 'Done', url: actionUrl(opts.publicUrl, doneToken), method: 'POST', clear: true },
      {
        label: '+1 hour',
        url: actionUrl(opts.publicUrl, snoozeToken),
        method: 'POST',
        clear: true,
      },
      {
        label: 'Tomorrow',
        url: actionUrl(opts.publicUrl, tomorrowToken),
        method: 'POST',
        clear: true,
      },
    ],
  };
}

export function bundlePush(opts: {
  items: Array<{ id: string; text: string; fireLocal: string }>;
  vaultName: string;
  notePath?: string;
}): PushMessage {
  const message = opts.items.map((item) => `${item.fireLocal} — ${item.text}`).join('\n');
  const notePath = opts.notePath ?? 'Today.md';
  const click = `obsidian://open?vault=${opts.vaultName}&file=${encodeURIComponent(notePath)}`;

  return {
    title: 'While I was offline',
    message,
    priority: 'default',
    click,
  };
}
