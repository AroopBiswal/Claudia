// Unit coverage for tests/eval/instance.ts: does startEvalInstance seed a real scratch vault,
// mint a working MCP bearer token through the real OAuth store, and map what gets saved back into
// SavedItem the way score.ts expects? No headless Claude Code here -- a real (but local-only) MCP
// client stands in for it, exercising the exact same capture/update tools the skill calls.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startEvalInstance, type EvalInstance } from '../../eval/instance.ts';
import type { EvalCase } from '../../eval/types.ts';

function baseCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'unit-case',
    category: 'personal',
    message: 'unused: this test drives the MCP tools directly',
    expect: [],
    ...overrides,
  };
}

async function connect(
  instance: EvalInstance,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${String(instance.port)}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${instance.token}` } } },
  );
  const client = new Client({ name: 'claudia-eval-instance-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
}

describe('startEvalInstance', () => {
  let instance: EvalInstance | undefined;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    await instance?.stop();
    instance = undefined;
    close = undefined;
  });

  it('seeds a scratch vault, not the real one, under os.tmpdir()', async () => {
    instance = await startEvalInstance(baseCase());
    expect(instance.vaultDir).toContain('claudia-eval-vault-');
    const readme = await readFile(join(instance.vaultDir, '_claudia/README.md'), 'utf8');
    expect(readme).toContain('Claudia is your assistant');
  });

  it('writes setup.rules into Rules.md in vault format before the service starts', async () => {
    instance = await startEvalInstance(
      baseCase({
        setup: {
          rules: [
            { text: 'Nothing about my therapy sessions', keywords: ['therapy', 'therapist'] },
          ],
        },
      }),
    );
    const rules = await readFile(join(instance.vaultDir, '_claudia/Rules.md'), 'utf8');
    const line = rules.split('\n').find((l) => l.includes('therapy sessions'));
    expect(line).toBeDefined();
    expect(line).toMatch(
      /^- Nothing about my therapy sessions 🚫 therapy, therapist \^r[a-z0-9]{4}$/,
    );
  });

  it('reports zero saved items and zero rulesAdded before anything is captured', async () => {
    instance = await startEvalInstance(
      baseCase({ setup: { rules: [{ text: 'no health stuff', keywords: ['health'] }] } }),
    );
    expect(await instance.savedItems()).toEqual([]);
    expect(instance.rulesAdded()).toBe(0);
  });

  it('mints a bearer token that the real MCP layer accepts, and maps every kind to SavedItem', async () => {
    instance = await startEvalInstance(baseCase());
    const connection = await connect(instance);
    close = connection.close;
    const { client } = connection;

    const captured = await client.callTool({
      name: 'capture',
      arguments: {
        items: [
          {
            kind: 'task',
            text: 'Call the dentist',
            remind_at: 'tomorrow 09:00',
            repeat: 'every week',
          },
          {
            kind: 'follow_up',
            text: 'send the referral link',
            person: 'Sam',
            direction: 'promised',
            due: 'friday',
          },
          { kind: 'appointment', text: 'Dentist cleaning', start: 'tomorrow 15:00' },
          { kind: 'fact', text: 'Birthday is October 12', person: 'Maya' },
        ],
        surface: 'Claude Code',
        source_words: 'unit test capture',
      },
    });
    expect(captured.isError).toBeFalsy();

    const saved = await instance.savedItems();
    expect(saved).toHaveLength(4);

    const task = saved.find((s) => s.kind === 'task');
    expect(task?.text).toContain('Call the dentist');
    expect(task?.reminderLocal).toMatch(/^\d{4}-\d{2}-\d{2} 09:00$/);
    expect(task?.repeat).toContain('week');
    expect(task?.path).toBe('Tasks/To do.md');
    expect(task?.person).toBeNull();

    const followUp = saved.find((s) => s.kind === 'follow_up');
    expect(followUp?.person).toBe('Sam');
    expect(followUp?.people).toContain('Sam');
    expect(followUp?.direction).toBe('promised');
    expect(followUp?.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(followUp?.path).toBe('Tasks/Follow-ups.md');

    const appointment = saved.find((s) => s.kind === 'appointment');
    expect(appointment?.appointmentStart).toMatch(/^\d{4}-\d{2}-\d{2} 15:00$/);
    expect(appointment?.path).toBe('Tasks/Appointments.md');

    const fact = saved.find((s) => s.kind === 'fact');
    expect(fact?.person).toBe('Maya');
    expect(fact?.text).toContain('Birthday');
    expect(fact?.path).toBe('People/Maya.md');

    // add_rule (via `update`) is reflected by rulesAdded(), not savedItems() -- Rules.md isn't
    // under Tasks/, People/ or Memory/.
    const added = await client.callTool({
      name: 'update',
      arguments: {
        action: 'add_rule',
        text: 'Nothing about my finances',
        keywords: ['finances', 'money'],
      },
    });
    expect(added.isError).toBeFalsy();
    expect(instance.rulesAdded()).toBe(1);
    expect(await instance.savedItems()).toHaveLength(4);
  });

  it('refuses a capture that matches a setup rule, and rulesAdded stays 0', async () => {
    instance = await startEvalInstance(
      baseCase({
        setup: {
          rules: [
            { text: 'Nothing about my therapy sessions', keywords: ['therapy', 'therapist'] },
          ],
        },
      }),
    );
    const connection = await connect(instance);
    close = connection.close;

    const result = await connection.client.callTool({
      name: 'capture',
      arguments: {
        items: [
          {
            kind: 'task',
            text: 'Therapist appointment Thursday at 4pm',
            remind_at: 'thursday 16:00',
          },
        ],
        surface: 'Claude Code',
      },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { results: Array<{ status: string }> };
    expect(structured.results[0]?.status).toBe('refused');

    expect(await instance.savedItems()).toEqual([]);
    expect(instance.rulesAdded()).toBe(0);
  });
});
