// E2E scenario 6: an iCloud conflict copy (vault-format.md section 9). The
// vault file watcher recognizes "Tasks/To do 2.md" as a conflict copy of
// "Tasks/To do.md" the moment it appears (real fs.watch, no manual trigger),
// merges it by block id, deletes the copy and logs the merge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2E, waitFor, type E2EService } from '../helpers/e2e-service.ts';

interface StructuredCaptureItem {
  index: number;
  status: string;
  id?: string;
}

describe('e2e: iCloud conflict copy merge', () => {
  let e2e: E2EService;
  let idA: string; // stays open and textually identical in both files
  let idB: string; // done only in the copy: done wins over open
  let originalBefore: string;

  beforeAll(async () => {
    e2e = await startE2E();

    const result = await e2e.mcp.callTool({
      name: 'capture',
      arguments: {
        items: [
          { kind: 'task', text: 'Buy groceries' },
          { kind: 'task', text: 'Return library book' },
        ],
      },
    });
    const results = (result.structuredContent as { results: StructuredCaptureItem[] }).results;
    idA = results[0]!.id!;
    idB = results[1]!.id!;
    originalBefore = await e2e.readVault('Tasks/To do.md');
    expect(originalBefore).toContain(`Buy groceries ^${idA}`);
    expect(originalBefore).toContain(`Return library book ^${idB}`);
  });

  afterAll(async () => {
    await e2e.stop();
  });

  it('merges a copy (one item completed, one new item) into the original and deletes the copy', async () => {
    // A conflict copy an iCloud/Obsidian sync race could plausibly produce: idB got completed on
    // another device, and a brand-new line (no id shared with the original) got added there too.
    const copyContent =
      originalBefore
        .replace(
          `- [ ] Return library book ^${idB}`,
          `- [x] Return library book ✅ 2026-09-26 ^${idB}`,
        )
        .replace(/\n$/, '') + '\n- [ ] Pack for trip ^tcopy\n';

    await e2e.writeVault('Tasks/To do 2.md', copyContent);

    await waitFor(() => e2e.vaultExists('Tasks/To do 2.md').then((exists) => !exists), {
      timeoutMs: 3000,
      message: 'the janitor never deleted the conflict copy',
    });

    const merged = await e2e.readVault('Tasks/To do.md');
    expect(merged).toContain(`- [ ] Buy groceries ^${idA}`);
    expect(merged).toContain(`- [x] Return library book ✅ 2026-09-26 ^${idB}`);
    expect(merged).toContain('- [ ] Pack for trip ^tcopy');
    // The new line lands right after its nearest preceding neighbor from the copy (idB).
    expect(merged.indexOf('Pack for trip')).toBeGreaterThan(merged.indexOf('Return library book'));

    const log = await e2e.readVault('Log/2026-09-26.md');
    expect(log).toContain('merged conflict copy [[To do]] (Tasks/To do 2.md)');

    // The merge is reflected in the index too, not just the file.
    const recalled = await e2e.mcp.callTool({
      name: 'recall',
      arguments: { query: 'library book', include_done: true },
    });
    const found = (
      recalled.structuredContent as { results: Array<{ id: string; status: string }> }
    ).results.find((r) => r.id === idB);
    expect(found?.status).toBe('done');
  });
});
