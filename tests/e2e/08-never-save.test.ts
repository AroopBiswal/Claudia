// E2E scenario 8: never-save rules (vault-format.md section 5 "_claudia/Rules.md")
// and the always-on sensitive-data guard (src/vault/rules.ts sensitiveGuard).
// Both refuse the capture outright: nothing is written to the vault.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2E, type E2EService } from '../helpers/e2e-service.ts';

interface StructuredCaptureItem {
  index: number;
  status: string;
  reason?: string;
}

describe('e2e: never-save rules and the sensitive-data guard', () => {
  let e2e: E2EService;

  beforeAll(async () => {
    e2e = await startE2E();
  });

  afterAll(async () => {
    await e2e.stop();
  });

  it('adding a never-save rule then refuses a matching capture, naming the rule and keyword', async () => {
    const added = await e2e.mcp.callTool({
      name: 'update',
      arguments: {
        action: 'add_rule',
        text: 'Nothing about my therapy sessions',
        keywords: ['therapy', 'therapist'],
      },
    });
    expect(added.isError).toBeFalsy();
    expect((added.structuredContent as { status: string }).status).toBe('ok');

    const rules = await e2e.readVault('_claudia/Rules.md');
    expect(rules).toContain('Nothing about my therapy sessions 🚫 therapy, therapist');

    const before = await e2e.readVault('Tasks/To do.md');

    const captured = await e2e.mcp.callTool({
      name: 'capture',
      arguments: {
        items: [{ kind: 'task', text: 'Book an appointment with my therapist' }],
      },
    });
    const result = (captured.structuredContent as { results: StructuredCaptureItem[] }).results[0]!;
    expect(result.status).toBe('refused');
    expect(result.reason).toContain('Nothing about my therapy sessions');
    expect(result.reason).toMatch(/therapist/i);

    // Nothing was written.
    const after = await e2e.readVault('Tasks/To do.md');
    expect(after).toBe(before);
    expect(after).not.toContain('therapist');
  });

  it('refuses a capture containing what looks like a card number, and writes nothing', async () => {
    const before = await e2e.readVault('Tasks/To do.md');

    const captured = await e2e.mcp.callTool({
      name: 'capture',
      arguments: {
        items: [{ kind: 'task', text: 'My card number is 4111 1111 1111 1111' }],
      },
    });
    const result = (captured.structuredContent as { results: StructuredCaptureItem[] }).results[0]!;
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/account or id number/i);

    const after = await e2e.readVault('Tasks/To do.md');
    expect(after).toBe(before);
    expect(after).not.toContain('4111');
  });
});
