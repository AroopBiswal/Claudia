// notify (docs/tools.md): sends a push via the configured Notifier and,
// optionally, replaces Today's Brief section and/or marks the brief published.

import { z } from 'zod';
import type { PushMessage, Priority } from '../notify/ntfy.ts';
import { LAYOUT, obsidianUri } from '../vault/layout.ts';
import { nowLabel, todayOf, type ClaudiaContext } from './context.ts';
import { refreshGenerated } from './generated.ts';

export const notifyInputSchema = z.object({
  message: z.string().min(1).describe('The push notification body.'),
  title: z.string().optional().describe('Push title; defaults to "Claudia".'),
  priority: z
    .enum(['low', 'default', 'high'])
    .optional()
    .describe('Push priority; defaults to "default".'),
  kind: z
    .enum(['message', 'brief'])
    .optional()
    .describe('"brief" marks today\'s brief as published, stopping the server fallback.'),
  today_summary: z
    .string()
    .optional()
    .describe('Markdown that replaces the Brief section of Today.md.'),
  open_id: z
    .string()
    .optional()
    .describe('An item ID to open when the push is tapped; defaults to opening Today.md.'),
});

export type NotifyInput = z.input<typeof notifyInputSchema>;

export interface NotifyResult {
  now: string;
  status: 'sent' | 'failed';
  today_updated: boolean;
  reason?: string;
}

export interface NotifyError {
  error: string;
}

/** Send a push to the owner's phone and optionally write Claude's summary into Today. */
export async function notify(
  ctx: ClaudiaContext,
  input: unknown,
): Promise<NotifyResult | NotifyError> {
  const parsed = notifyInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: z.prettifyError(parsed.error) };
  }

  const { message, title, priority, kind, today_summary, open_id } = parsed.data;
  const today = todayOf(ctx);

  let today_updated = false;
  if (today_summary !== undefined) {
    ctx.state.setKv(`today-summary:${today}`, today_summary);
    await refreshGenerated(ctx);
    today_updated = true;
  }

  let click: string;
  const openItem = open_id ? ctx.index.getItem(open_id) : null;
  if (openItem) {
    click = obsidianUri(ctx.vaultName, openItem.path, openItem.id ?? undefined);
  } else {
    click = obsidianUri(ctx.vaultName, LAYOUT.today);
  }

  const pushPriority: Priority = priority ?? 'default';
  const pushMessage: PushMessage = {
    title: title ?? 'Claudia',
    message,
    priority: pushPriority,
    click,
  };

  let status: 'sent' | 'failed';
  let reason: string | undefined;

  if (!ctx.notifier) {
    status = 'failed';
    reason = 'Push is not configured yet';
  } else {
    const sent = await ctx.notifier.send(pushMessage);
    if (sent.ok) {
      status = 'sent';
    } else {
      status = 'failed';
      reason = sent.error;
    }
  }

  if (kind === 'brief') {
    // The brief was published to Today regardless of push delivery.
    ctx.state.markFired(`brief:${today}`, 'brief');
  }

  return {
    now: nowLabel(ctx),
    status,
    today_updated,
    ...(reason !== undefined ? { reason } : {}),
  };
}
