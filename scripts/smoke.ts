#!/usr/bin/env node
// Local smoke test against the INSTALLED Claudia service (never the dev
// server): a real MCP session over HTTP, a captured timed reminder, the
// vault line it produces, the reminder firing through the real local ntfy
// server, completing it via the signed Done push action, and removing the
// smoke item again. See docs/KICKOFF.md M8 and this task's brief.
//
// Reads ~/.claudia/config.json (or $CLAUDIA_HOME/config.json). Never prints
// a secret: not the minted OAuth token, not the ntfy access token.
//
// Usage: node scripts/smoke.ts   (also wired up as `npm run smoke`)
//
// The pure pieces below (rewriteOrigin, parseNtfyMessages, findDoneAction,
// findLineByBlockId, hasReminderField, isLineDone) are unit-tested with fake
// data in tests/unit/ops/smoke.test.ts; everything else here is I/O
// orchestration exercised only by actually running the smoke test against
// an installed service.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.ts';
import { openState } from '../src/engine/state.ts';
import { createOAuthStore } from '../src/auth/store.ts';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Rewrites a URL's scheme and host:port to `newOrigin`, keeping its path,
 * query and hash. Used to turn a signed Done push action's public URL
 * (`https://claudia.aroopbiswal.com/a/...`) into a loopback one
 * (`http://127.0.0.1:8787/a/...`) so the smoke test never needs the tunnel
 * or Cloudflare Access to be live.
 */
export function rewriteOrigin(url: string, newOrigin: string): string {
  const target = new URL(url);
  const origin = new URL(newOrigin);
  target.protocol = origin.protocol;
  target.host = origin.host;
  return target.toString();
}

export interface NtfyAction {
  id?: string;
  action: string;
  label?: string;
  url?: string;
  method?: string;
  clear?: boolean;
  [key: string]: unknown;
}

export interface NtfyMessage {
  id: string;
  time: number;
  event: string;
  topic: string;
  title?: string;
  message?: string;
  actions?: NtfyAction[];
  [key: string]: unknown;
}

/**
 * Parses ntfy's `/<topic>/json?poll=1` response: one JSON object per line,
 * some of which are non-message events (e.g. `open`). Malformed lines are
 * skipped rather than throwing, since a poll response is never expected to
 * contain any.
 */
export function parseNtfyMessages(body: string): NtfyMessage[] {
  const messages: NtfyMessage[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { event?: unknown }).event === 'message'
    ) {
      messages.push(parsed as NtfyMessage);
    }
  }
  return messages;
}

/** Finds the push action that completes the reminder: an http action labeled "Done" whose URL contains `/a/`. */
export function findDoneAction(message: NtfyMessage): NtfyAction | undefined {
  return (message.actions ?? []).find(
    (action) =>
      action.action === 'http' &&
      typeof action.url === 'string' &&
      action.url.includes('/a/') &&
      /done/i.test(action.label ?? ''),
  );
}

/** Finds the vault line ending in the given block ID (` ^<id>`, trailing whitespace tolerated). */
export function findLineByBlockId(content: string, id: string): string | undefined {
  const suffix = `^${id}`;
  return content.split(/\r\n|\r|\n/).find((line) => line.trimEnd().endsWith(suffix));
}

/** Whether a To do.md line carries a ⏰ reminder field. */
export function hasReminderField(line: string): boolean {
  return line.includes('⏰');
}

/** Whether a line has been marked done (`- [x]` plus a ✅ completion date). */
export function isLineDone(line: string): boolean {
  return /-\s\[x\]/i.test(line) && /✅ \d{4}-\d{2}-\d{2}/.test(line);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

interface ToolCallResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as ToolCallResult;
  if (result.isError) {
    throw new Error(`tool "${name}" returned isError: ${JSON.stringify(result.content)}`);
  }
  if (!result.structuredContent) {
    throw new Error(`tool "${name}" result is missing structuredContent`);
  }
  return result.structuredContent;
}

class SmokeFailure extends Error {}

async function main(): Promise<void> {
  const config = loadConfig();
  const timings: Record<string, number> = {};
  const overallStart = Date.now();

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      timings[name] = Date.now() - start;
      console.log(`✔ ${name}`);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`✘ ${name}: ${reason}`);
      process.exit(1);
    }
  }

  const baseUrl = `http://${config.host}:${config.port}`;

  // 1. /health
  await step('GET /health returns 200 ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    if (res.status !== 200) throw new SmokeFailure(`expected HTTP 200, got ${res.status}`);
    const body = (await res.json()) as { status?: string };
    if (body.status !== 'ok') {
      throw new SmokeFailure(`expected status "ok", got ${JSON.stringify(body.status)}`);
    }
  });

  // 2. mint a short-lived admin token
  const state = openState({ dbPath: config.paths.stateDb });
  const store = createOAuthStore(state.db, { now: () => new Date() });
  store.migrate();

  const SMOKE_REDIRECT_URI = 'http://127.0.0.1/smoke-callback';
  const SMOKE_CLIENT_KV_KEY = 'smoke:oauthClientId';

  const accessToken = await step('token issued', () => {
    let clientId = state.getKv(SMOKE_CLIENT_KV_KEY);
    if (!clientId || !store.getClient(clientId)) {
      const registered = store.registerClient({
        redirectUris: [SMOKE_REDIRECT_URI],
        clientName: 'claudia-smoke',
      });
      clientId = registered.clientId;
      state.setKv(SMOKE_CLIENT_KV_KEY, clientId);
    }
    const subject = config.ownerEmail ?? 'owner';
    const tokens = store.issueTokens(clientId, subject, 'claudia', `${config.publicUrl}/mcp`);
    return Promise.resolve(tokens.accessToken);
  });

  // 3. MCP session
  const client = new Client({ name: 'claudia-smoke', version: '0.1.0' });
  await step('MCP session initializes and lists the five tools', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    await client.connect(transport);
    const toolsResult = (await client.listTools()) as { tools: { name: string }[] };
    const names = toolsResult.tools.map((t) => t.name);
    for (const required of ['capture', 'recall', 'agenda', 'update', 'notify']) {
      if (!names.includes(required)) {
        throw new SmokeFailure(`tool list is missing "${required}" (got: ${names.join(', ')})`);
      }
    }
  });

  // 4. capture a clearly labeled, timed reminder
  const itemId = await step('capture saves a timed reminder', async () => {
    const structured = await callTool(client, 'capture', {
      items: [
        {
          kind: 'task',
          text: 'Claudia smoke test (safe to ignore, removed automatically)',
          remind_at: '+1m',
        },
      ],
      surface: 'smoke test',
    });
    const results = structured.results as { status?: string; id?: string }[] | undefined;
    const first = results?.[0];
    if (!first || first.status !== 'saved') {
      throw new SmokeFailure(`expected status "saved", got ${JSON.stringify(first?.status)}`);
    }
    if (!first.id) throw new SmokeFailure('capture result is missing an id');
    if (!structured.receipt) throw new SmokeFailure('capture result is missing a receipt');
    return first.id;
  });

  // 5. the vault line appears
  const toDoPath = join(config.vaultPath, 'Tasks', 'To do.md');
  await step('the reminder line appears in Tasks/To do.md', async () => {
    const content = await readFile(toDoPath, 'utf8');
    const line = findLineByBlockId(content, itemId);
    if (!line) throw new SmokeFailure(`no line ending with ^${itemId} in ${toDoPath}`);
    if (!hasReminderField(line)) throw new SmokeFailure(`line ^${itemId} has no ⏰ field: ${line}`);
  });

  // 6. the scheduler fires it through local ntfy
  const doneUrl = await step('the scheduler fires the reminder through local ntfy', async () => {
    const topic = config.ntfy.topic;
    if (!topic) throw new SmokeFailure('ntfy.topic is not configured');
    const ntfyToken = (await readFile(config.ntfy.tokenFile, 'utf8')).trim();
    const since = Math.floor(overallStart / 1000);
    const deadline = Date.now() + 150_000;

    while (Date.now() < deadline) {
      const res = await fetch(`${config.ntfy.baseUrl}/${topic}/json?poll=1&since=${since}`, {
        headers: { Authorization: `Bearer ${ntfyToken}` },
      });
      if (res.ok) {
        const messages = parseNtfyMessages(await res.text());
        for (const message of messages) {
          const action = findDoneAction(message);
          if (action?.url) {
            console.log(`  title: ${message.title ?? '(none)'}`);
            console.log(`  text:  ${message.message ?? '(none)'}`);
            return action.url;
          }
        }
      }
      await sleep(5000);
    }
    throw new SmokeFailure('no push with a Done action arrived within 150s');
  });

  // 7. the signed Done link completes it
  await step('the signed Done link completes the reminder', async () => {
    const loopbackUrl = rewriteOrigin(doneUrl, baseUrl);
    const res = await fetch(loopbackUrl, { method: 'POST' });
    if (res.status < 200 || res.status >= 300) {
      throw new SmokeFailure(`Done link returned HTTP ${res.status}`);
    }
    const content = await readFile(toDoPath, 'utf8');
    const line = findLineByBlockId(content, itemId);
    if (!line || !isLineDone(line)) {
      throw new SmokeFailure(`line ^${itemId} does not show as done: ${line ?? '(missing)'}`);
    }
  });

  // 8. remove the smoke item
  await step('update forget removes the smoke item', async () => {
    const structured = await callTool(client, 'update', { action: 'forget', id: itemId });
    if (structured.status !== 'ok') {
      throw new SmokeFailure(`expected status "ok", got ${JSON.stringify(structured.status)}`);
    }
    const content = await readFile(toDoPath, 'utf8');
    if (findLineByBlockId(content, itemId)) {
      throw new SmokeFailure(`line ^${itemId} is still present in ${toDoPath} after forget`);
    }
  });

  // 9. revoke the token and close up
  await step('token revoked and MCP session closed', async () => {
    store.revokeToken(accessToken);
    await client.close();
    state.close();
  });

  console.log('');
  console.log('SMOKE TEST PASSED');
  for (const [name, ms] of Object.entries(timings)) {
    console.log(`  ${ms.toString().padStart(6)}ms  ${name}`);
  }
  console.log(`  ${(Date.now() - overallStart).toString().padStart(6)}ms  total`);
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
