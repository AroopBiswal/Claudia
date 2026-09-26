import { describe, expect, it } from 'vitest';
import { runJanitor } from '../../../src/engine/janitor.ts';
import { createVaultWriter } from '../../../src/engine/writer.ts';
import {
  createTempVault,
  readVaultFile,
  removeTempVault,
  setMtime,
  vaultFileExists,
} from '../../helpers/temp-vault.ts';

async function withTempVault(
  files: Record<string, string>,
  fn: (vaultDir: string) => Promise<void>,
): Promise<void> {
  const vaultDir = await createTempVault(files);
  try {
    await fn(vaultDir);
  } finally {
    await removeTempVault(vaultDir);
  }
}

describe('runJanitor', () => {
  it('leaves an unrelated numbered file alone when it shares no block ids with the base', async () => {
    await withTempVault(
      {
        'Tasks/Plan.md': '# Plan\n\n- [ ] Do the thing ^t0001\n',
        'Tasks/Plan 2.md': '# Plan\n\n- [ ] A totally different plan ^t9999\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const reports = await runJanitor({ vaultDir, writer, relPaths: ['Tasks/Plan 2.md'] });
        expect(reports).toEqual([]);
        expect(await vaultFileExists(vaultDir, 'Tasks/Plan 2.md')).toBe(true);
      },
    );
  });

  it('does nothing when there is no original note', async () => {
    await withTempVault(
      { 'Tasks/Orphan 2.md': '# Orphan\n\n- [ ] Something ^t0001\n' },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const reports = await runJanitor({ vaultDir, writer, relPaths: ['Tasks/Orphan 2.md'] });
        expect(reports).toEqual([]);
        expect(await vaultFileExists(vaultDir, 'Tasks/Orphan 2.md')).toBe(true);
      },
    );
  });

  it('done/cancelled wins over open for a line present in both, regardless of mtime', async () => {
    await withTempVault(
      {
        'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist ^t0001\n',
        'Tasks/To do 2.md': '# To do\n\n- [x] Call the dentist ✅ 2026-09-25 ^t0001\n',
      },
      async (vaultDir) => {
        // Original is newer than the copy, but the copy's line is done: done wins.
        await setMtime(vaultDir, 'Tasks/To do 2.md', new Date('2026-09-25T10:00:00Z'));
        await setMtime(vaultDir, 'Tasks/To do.md', new Date('2026-09-26T10:00:00Z'));
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const reports = await runJanitor({ vaultDir, writer, relPaths: ['Tasks/To do 2.md'] });
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          copy: 'Tasks/To do 2.md',
          original: 'Tasks/To do.md',
          linesFromCopy: 1,
          linesKept: 0,
          linesAdded: 0,
        });
        const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
        expect(text).toBe('# To do\n\n- [x] Call the dentist ✅ 2026-09-25 ^t0001\n');
        expect(await vaultFileExists(vaultDir, 'Tasks/To do 2.md')).toBe(false);
      },
    );
  });

  it('when both are open or both are done, the newer mtime wins', async () => {
    await withTempVault(
      {
        'Tasks/To do.md': '# To do\n\n- [ ] Old text ^t0001\n',
        'Tasks/To do 2.md': '# To do\n\n- [ ] New text ^t0001\n',
      },
      async (vaultDir) => {
        await setMtime(vaultDir, 'Tasks/To do.md', new Date('2026-09-25T10:00:00Z'));
        await setMtime(vaultDir, 'Tasks/To do 2.md', new Date('2026-09-26T10:00:00Z'));
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const reports = await runJanitor({ vaultDir, writer, relPaths: ['Tasks/To do 2.md'] });
        expect(reports[0]).toMatchObject({ linesFromCopy: 1, linesKept: 0 });
        const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
        expect(text).toBe('# To do\n\n- [ ] New text ^t0001\n');
      },
    );
  });

  it('keeps the original when it is newer and both lines have the same open/done state', async () => {
    await withTempVault(
      {
        'Tasks/To do.md': '# To do\n\n- [ ] Newer original text ^t0001\n',
        'Tasks/To do 2.md': '# To do\n\n- [ ] Older copy text ^t0001\n',
      },
      async (vaultDir) => {
        await setMtime(vaultDir, 'Tasks/To do 2.md', new Date('2026-09-25T10:00:00Z'));
        await setMtime(vaultDir, 'Tasks/To do.md', new Date('2026-09-26T10:00:00Z'));
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const reports = await runJanitor({ vaultDir, writer, relPaths: ['Tasks/To do 2.md'] });
        expect(reports[0]).toMatchObject({ linesFromCopy: 0, linesKept: 1 });
        const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
        expect(text).toBe('# To do\n\n- [ ] Newer original text ^t0001\n');
      },
    );
  });

  it('inserts a block-id-only-in-copy line after its nearest preceding shared neighbor', async () => {
    await withTempVault(
      {
        'Tasks/To do.md': '# To do\n\n- [ ] One ^t0001\n- [ ] Three ^t0003\n',
        'Tasks/To do 2.md':
          '# To do\n\n- [ ] One ^t0001\n- [ ] Two (new in copy) ^t0002\n- [ ] Three ^t0003\n',
      },
      async (vaultDir) => {
        // Same text either way for the matched lines, but make the original newer so a
        // same-open-state match is attributed to "kept" rather than "from copy".
        await setMtime(vaultDir, 'Tasks/To do 2.md', new Date('2026-09-25T10:00:00Z'));
        await setMtime(vaultDir, 'Tasks/To do.md', new Date('2026-09-26T10:00:00Z'));
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const reports = await runJanitor({ vaultDir, writer, relPaths: ['Tasks/To do 2.md'] });
        expect(reports[0]).toMatchObject({ linesAdded: 1, linesKept: 2 });
        const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
        expect(text).toBe(
          '# To do\n\n- [ ] One ^t0001\n- [ ] Two (new in copy) ^t0002\n- [ ] Three ^t0003\n',
        );
      },
    );
  });

  it('appends a block-id-only-in-copy line at the end when it has no preceding shared neighbor', async () => {
    await withTempVault(
      {
        'Tasks/To do.md': '# To do\n\n- [ ] One ^t0001\n',
        'Tasks/To do 2.md':
          '# To do\n\n- [ ] Zero (new, before any shared line) ^t0000\n- [ ] One ^t0001\n',
      },
      async (vaultDir) => {
        await setMtime(vaultDir, 'Tasks/To do.md', new Date('2026-09-25T10:00:00Z'));
        await setMtime(vaultDir, 'Tasks/To do 2.md', new Date('2026-09-26T10:00:00Z'));
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        await runJanitor({ vaultDir, writer, relPaths: ['Tasks/To do 2.md'] });
        const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
        expect(text).toBe(
          '# To do\n\n- [ ] One ^t0001\n- [ ] Zero (new, before any shared line) ^t0000\n',
        );
      },
    );
  });

  it('appends non-blank, non-heading lines without a block id that only exist in the copy', async () => {
    await withTempVault(
      {
        'Tasks/To do.md': '# To do\n\n- [ ] One ^t0001\n',
        'Tasks/To do 2.md': '# To do\n\n- [ ] One ^t0001\n- A note the owner typed with no id\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        await runJanitor({ vaultDir, writer, relPaths: ['Tasks/To do 2.md'] });
        const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
        expect(text).toBe('# To do\n\n- [ ] One ^t0001\n- A note the owner typed with no id\n');
      },
    );
  });

  it('skips a duplicate heading already present, but appends other non-blank text', async () => {
    await withTempVault(
      {
        'Tasks/To do.md': '# To do\n\n- [ ] One ^t0001\n',
        'Tasks/To do 2.md': '# To do\n\n- [ ] One ^t0001\n\n- Extra note with no id\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        await runJanitor({ vaultDir, writer, relPaths: ['Tasks/To do 2.md'] });
        const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
        // The "# To do" heading in the copy is already present, so it's not duplicated;
        // the blank line is skipped; the extra note is appended.
        expect(text).toBe('# To do\n\n- [ ] One ^t0001\n- Extra note with no id\n');
      },
    );
  });

  it('removes the copy after merging', async () => {
    await withTempVault(
      {
        'Tasks/To do.md': '# To do\n\n- [ ] One ^t0001\n',
        'Tasks/To do 2.md': '# To do\n\n- [x] One ✅ 2026-09-25 ^t0001\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        await runJanitor({ vaultDir, writer, relPaths: ['Tasks/To do 2.md'] });
        expect(await vaultFileExists(vaultDir, 'Tasks/To do 2.md')).toBe(false);
      },
    );
  });

  it('scans the whole vault when relPaths is omitted', async () => {
    await withTempVault(
      {
        'Tasks/To do.md': '# To do\n\n- [ ] One ^t0001\n',
        'Tasks/To do 2.md': '# To do\n\n- [x] One ✅ 2026-09-25 ^t0001\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const reports = await runJanitor({ vaultDir, writer });
        expect(reports).toHaveLength(1);
        expect(await vaultFileExists(vaultDir, 'Tasks/To do 2.md')).toBe(false);
      },
    );
  });
});
