// MCP layer (docs/tools.md): five tools over stateless Streamable HTTP.
// `createMcpServer` wires the tool schemas from src/services/* into an
// McpServer; `createMcpHandler` adapts that into an Express RequestHandler,
// creating a fresh server + transport per POST (stateless, per the MCP SDK's
// recommended pattern) and rejecting GET/DELETE per the MCP spec.

import type { IncomingMessage } from 'node:http';
import type { Request, RequestHandler, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { agenda, agendaInputSchema } from '../services/agenda.ts';
import { capture, captureInputSchema, type CaptureResult } from '../services/capture.ts';
import type { ClaudiaContext } from '../services/context.ts';
import { notify, notifyInputSchema, type NotifyResult } from '../services/notify.ts';
import { recall, recallInputSchema, type RecallResult } from '../services/recall.ts';
import { update, updateInputSchema, type UpdateResult } from '../services/update.ts';
import type { ItemView } from '../services/views.ts';
import { VERSION } from '../version.ts';

export const SERVER_INSTRUCTIONS =
  "Claudia is the owner's personal assistant memory: tasks, reminders, follow-ups, appointments, " +
  'people and facts, stored in their Obsidian vault. Save personal commitments, dates, appointments, ' +
  'people and lasting facts with `capture`, silently, except for one-line reminder receipts. Do not ' +
  'save code, general knowledge, learning material or one-off lookups. Check `agenda` or `recall` ' +
  'before answering questions about plans, people, schedules or commitments. Times are in the ' +
  "owner's time zone (Pacific unless Settings say otherwise); prefer relative time expressions such " +
  'as `tomorrow 09:00`, `tuesday 15:00` or `+2h` and let the server resolve them. Never save ' +
  'passwords, account numbers or ID numbers.';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textResult(text: string, structuredContent: object): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structuredContent as unknown as Record<string, unknown>,
  };
}

function isErrorResult(text: string, structuredContent: object): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structuredContent as unknown as Record<string, unknown>,
    isError: true,
  };
}

function genericErrorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// --- text summaries for each tool's content block ---------------------------------------------

function captureSummary(result: CaptureResult): string {
  if (result.receipt) return result.receipt;
  const savedCount = result.results.filter((r) => r.status === 'saved').length;
  if (savedCount > 0) {
    return `Saved ${String(savedCount)} item${savedCount === 1 ? '' : 's'}.`;
  }
  const reasons = result.results
    .map((r) => r.reason)
    .filter((r): r is string => r !== undefined && r.length > 0);
  return reasons.length > 0 ? reasons.join(' ') : 'Nothing saved.';
}

function itemLine(item: ItemView): string {
  const bits: string[] = [];
  if (item.reminder) bits.push(`⏰ ${item.reminder}`);
  if (item.appointment) bits.push(`🗓️ ${item.appointment}`);
  if (item.due) bits.push(`📅 ${item.due}`);
  if (item.repeat) bits.push(`🔁 ${item.repeat}`);
  if (item.status !== 'open') bits.push(item.status);
  const suffix = bits.length > 0 ? ` (${bits.join(', ')})` : '';
  const id = item.id ? ` [${item.id}]` : '';
  return `${item.text}${suffix}${id}`;
}

function recallSummary(result: RecallResult): string {
  if (result.results.length === 0) return 'No results.';
  const lines = result.results.map((item) => `  - ${itemLine(item)}`);
  const total = result.total;
  return [`Found ${String(total)} result${total === 1 ? '' : 's'}:`, ...lines].join('\n');
}

function notifySummary(result: NotifyResult): string {
  const base =
    result.status === 'sent'
      ? 'Sent.'
      : `Failed to send${result.reason ? `: ${result.reason}.` : '.'}`;
  return result.today_updated ? `${base} Today updated.` : base;
}

// --- tool registration --------------------------------------------------------------------------

export function createMcpServer(ctx: ClaudiaContext): McpServer {
  const server = new McpServer(
    { name: 'claudia', version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'capture',
    {
      title: 'Capture',
      description:
        'Save personal commitments to Claudia’s memory: facts, tasks and reminders, follow-ups ' +
        '(waiting on / promised), and appointments. Accepts 1 to 20 items in one call. Use it ' +
        'silently whenever the user states a plan, date, person or lasting fact; the only visible ' +
        'effect is a one-line receipt when a timed reminder is set. Key fields per item: kind ' +
        '(task/follow_up/appointment/fact), text, remind_at/due (time or date expressions such as ' +
        '"tomorrow 09:00" or "+2h"), repeat (tasks), person and direction (follow_up), start/end ' +
        '(appointment), topic/expires (fact). Returns one result per item: saved, duplicate (an open ' +
        'item like this already exists), refused (a never-save rule or the sensitive-data guard), or ' +
        'invalid. Never save passwords, account numbers or ID numbers.',
      inputSchema: captureInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const result = await capture(ctx, args);
        return textResult(captureSummary(result), result);
      } catch (err) {
        ctx.log(`mcp capture failed: ${errorMessage(err)}`);
        return genericErrorResult('Something went wrong saving that. Please try again.');
      }
    },
  );

  server.registerTool(
    'recall',
    {
      title: 'Recall',
      description:
        "Search Claudia's memory by words: facts, people, tasks, follow-ups, appointments and rules. " +
        'Read-only. Call this (or agenda) before answering any question about the user’s plans, ' +
        'people, schedules or commitments — never answer from guesswork. Filter with kinds ' +
        '(task/follow_up/appointment/fact/rule), person (only items linked to that person’s ' +
        'note), include_done, and limit (1-50, default 10). An empty query with person set lists ' +
        'everything about that person. Returns matching items with id, status, text, note path, ' +
        'reminder/due/appointment/repeat/expires fields, tags, linked people, an Obsidian link, and ' +
        'whether a fact is stale.',
      inputSchema: recallInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      try {
        const result = recall(ctx, args);
        if ('error' in result) {
          return isErrorResult(result.error, result);
        }
        return textResult(recallSummary(result), result);
      } catch (err) {
        ctx.log(`mcp recall failed: ${errorMessage(err)}`);
        return genericErrorResult('Something went wrong searching. Please try again.');
      }
    },
  );

  server.registerTool(
    'agenda',
    {
      title: 'Agenda',
      description:
        "Time-based views over Claudia's memory: today, overdue, upcoming (next N days), follow_ups " +
        '(waiting/promised/nudges due), recent (recently captured), or brief (everything the morning ' +
        'brief needs, plus counts, settings and warnings). Read-only. Call this before answering ' +
        "questions about the user's schedule or open commitments. `days` sets the window for " +
        'upcoming/recent (default 7, max 60).',
      inputSchema: agendaInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await agenda(ctx, args);
        if ('error' in result) {
          return isErrorResult(result.error, result);
        }
        return textResult(result.text, result);
      } catch (err) {
        ctx.log(`mcp agenda failed: ${errorMessage(err)}`);
        return genericErrorResult('Something went wrong building the agenda. Please try again.');
      }
    },
  );

  server.registerTool(
    'update',
    {
      title: 'Update',
      description:
        'Change an existing item, undo a capture, or manage rules and settings. Actions: complete ' +
        '(repeating items get their next occurrence), reopen, snooze (until a later time than the ' +
        'current reminder), reschedule (remind_at/due, or start/end for an appointment; an empty ' +
        'string clears a field), edit (replace the text, keeping tags/links), forget (delete the ' +
        'line, cancelling any calendar event), undo (removes everything the most recent capture ' +
        'added; call again to undo the one before that), add_rule/remove_rule (never-save rules the ' +
        'user can see in the vault), set_setting (e.g. time zone, brief time). Requires id for every ' +
        'action except undo, add_rule and set_setting.',
      inputSchema: updateInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const result: UpdateResult = await update(ctx, args);
        if (result.status === 'invalid' || result.status === 'not_found') {
          return isErrorResult(result.message, result);
        }
        return textResult(result.message, result);
      } catch (err) {
        ctx.log(`mcp update failed: ${errorMessage(err)}`);
        return genericErrorResult('Something went wrong making that change. Please try again.');
      }
    },
  );

  server.registerTool(
    'notify',
    {
      title: 'Notify',
      description:
        "Send a push notification to the owner's phone, and optionally replace the Brief section of " +
        "Today.md with Claude's own summary. Use for the morning brief and for follow-up nudges the " +
        "scheduler didn't already send. kind: 'brief' marks today's brief as published (stopping the " +
        "server's fallback push); today_summary is markdown that becomes the new Brief section; " +
        'open_id makes tapping the push open that item in Obsidian instead of Today.md.',
      inputSchema: notifyInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await notify(ctx, args);
        if ('error' in result) {
          return isErrorResult(result.error, result);
        }
        return textResult(notifySummary(result), result);
      } catch (err) {
        ctx.log(`mcp notify failed: ${errorMessage(err)}`);
        return genericErrorResult('Something went wrong sending that. Please try again.');
      }
    },
  );

  return server;
}

/** Stateless per-POST handler for /mcp; GET and DELETE are rejected with 405 (Allow: POST). */
export function createMcpHandler(ctx: ClaudiaContext): RequestHandler {
  return (req: Request, res: Response, next) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST');
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      });
      return;
    }

    void handlePost(req, res).catch(next);
  };

  async function handlePost(req: Request, res: Response): Promise<void> {
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req as unknown as IncomingMessage, res, req.body);
  }
}
