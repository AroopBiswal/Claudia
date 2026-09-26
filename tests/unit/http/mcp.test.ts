import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, SERVER_INSTRUCTIONS } from '../../../src/http/mcp.ts';
import { capture } from '../../../src/services/capture.ts';
import type { ClaudiaContext } from '../../../src/services/context.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

async function connect(ctx: ClaudiaContext): Promise<Client> {
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claudia-mcp-unit-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  if (!('content' in result)) throw new Error('expected a CallToolResult with content');
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe('createMcpServer', () => {
  it('advertises the documented server instructions', async () => {
    t = await makeTestContext();
    const client = await connect(t.ctx);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it('lists exactly the five documented tools, each with a title, description and annotations', async () => {
    t = await makeTestContext();
    const client = await connect(t.ctx);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect([...byName.keys()].sort()).toEqual(['agenda', 'capture', 'notify', 'recall', 'update']);

    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.description!.length).toBeLessThan(900);
    }

    expect(byName.get('capture')?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.get('recall')?.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(byName.get('agenda')?.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(byName.get('update')?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.get('notify')?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('capture: saves a timed task and its text summary is the reminder receipt', async () => {
    t = await makeTestContext();
    const client = await connect(t.ctx);
    const result = await client.callTool({
      name: 'capture',
      arguments: { items: [{ kind: 'task', text: 'Buy milk', remind_at: 'tuesday 09:00' }] },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('Reminder set: Tue 9:00am.');
    const structured = result.structuredContent as { receipt?: string };
    expect(structured.receipt).toBe('Reminder set: Tue 9:00am.');
  });

  it('capture: an untimed save summarizes as "Saved N item(s)."', async () => {
    t = await makeTestContext();
    const client = await connect(t.ctx);
    const result = await client.callTool({
      name: 'capture',
      arguments: {
        items: [
          { kind: 'fact', text: 'Prefers window seats' },
          { kind: 'fact', text: 'Left-handed' },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('Saved 2 items.');
  });

  it('capture: an all-refused batch summarizes with the refusal reason', async () => {
    t = await makeTestContext();
    const client = await connect(t.ctx);
    const result = await client.callTool({
      name: 'capture',
      arguments: { items: [{ kind: 'task', text: 'my password is hunter2' }] },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/password/i);
  });

  it('recall: reports isError when neither query nor person is given', async () => {
    t = await makeTestContext();
    const client = await connect(t.ctx);
    const result = await client.callTool({ name: 'recall', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/query|person/i);
  });

  it('recall: renders a short list of matching items as the text summary', async () => {
    t = await makeTestContext();
    await capture(t.ctx, { items: [{ kind: 'task', text: 'Call the dentist' }] });
    const client = await connect(t.ctx);
    const result = await client.callTool({ name: 'recall', arguments: { query: 'dentist' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Found 1 result');
    expect(textOf(result)).toContain('dentist');
  });

  it('agenda: today view returns the rendered text and structured sections', async () => {
    t = await makeTestContext();
    const client = await connect(t.ctx);
    const result = await client.callTool({ name: 'agenda', arguments: { view: 'today' } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { view: string; appointments: unknown[] };
    expect(structured.view).toBe('today');
    expect(Array.isArray(structured.appointments)).toBe(true);
  });

  it('update: reports isError with a message for an unknown id', async () => {
    t = await makeTestContext();
    const client = await connect(t.ctx);
    const result = await client.callTool({
      name: 'update',
      arguments: { action: 'complete', id: 'tzzzz' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no item/i);
  });

  it('update: a successful action reports its message as the text summary', async () => {
    t = await makeTestContext();
    const client = await connect(t.ctx);
    const result = await client.callTool({
      name: 'update',
      arguments: {
        action: 'add_rule',
        text: 'Nothing about my fantasy football league',
        keywords: ['fantasy football'],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Added rule');
  });

  it('notify: reports failure with a reason when no notifier is configured', async () => {
    t = await makeTestContext({ files: {} });
    const brokenCtx: ClaudiaContext = { ...t.ctx, notifier: null };
    const client = await connect(brokenCtx);
    const result = await client.callTool({ name: 'notify', arguments: { message: 'hello' } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { status: string; reason?: string };
    expect(structured.status).toBe('failed');
    expect(textOf(result)).toMatch(/failed/i);
  });

  it('notify: a sent push summarizes as Sent.', async () => {
    t = await makeTestContext();
    const client = await connect(t.ctx);
    const result = await client.callTool({ name: 'notify', arguments: { message: 'hello' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('Sent.');
  });

  it('never lets a thrown error escape a tool handler', async () => {
    t = await makeTestContext();
    const logs: string[] = [];
    const brokenCtx: ClaudiaContext = {
      ...t.ctx,
      log: (message: string) => {
        logs.push(message);
      },
      index: {
        ...t.ctx.index,
        search: () => {
          throw new Error('boom');
        },
      },
    };
    const client = await connect(brokenCtx);
    const result = await client.callTool({ name: 'recall', arguments: { query: 'dentist' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('boom');
    expect(logs.some((line) => line.includes('boom'))).toBe(true);
  });
});
