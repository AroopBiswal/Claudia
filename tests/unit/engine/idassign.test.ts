import { describe, expect, it } from 'vitest';
import { assignMissingIds } from '../../../src/engine/idassign.ts';
import { createVaultWriter } from '../../../src/engine/writer.ts';
import { createTempVault, readVaultFile, removeTempVault } from '../../helpers/temp-vault.ts';

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

describe('assignMissingIds', () => {
  it('assigns ids to every list item lacking one in an id-managed note (Tasks/)', async () => {
    await withTempVault(
      { 'Tasks/To do.md': '# To do\n\n- [ ] Call the dentist\n- [ ] Renew passport ^t9999\n' },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const assigned = await assignMissingIds({
          writer,
          vaultDir,
          relPaths: ['Tasks/To do.md'],
          hasId: () => false,
        });
        expect(assigned).toHaveLength(1);
        expect(assigned[0]!.path).toBe('Tasks/To do.md');
        expect(assigned[0]!.id).toMatch(/^t[a-z0-9]{4}$/);
        const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
        expect(text).toContain(`Call the dentist ^${assigned[0]!.id}`);
        expect(text).toContain('Renew passport ^t9999');
      },
    );
  });

  it('assigns follow-up ids in Tasks/Follow-ups.md with kind letter t', async () => {
    await withTempVault(
      {
        'Tasks/Follow-ups.md': '# Follow-ups\n\n- [ ] Waiting on [[Alex]]: resume draft #waiting\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const assigned = await assignMissingIds({
          writer,
          vaultDir,
          relPaths: ['Tasks/Follow-ups.md'],
          hasId: () => false,
        });
        expect(assigned).toHaveLength(1);
        expect(assigned[0]!.id.startsWith('t')).toBe(true);
      },
    );
  });

  it('assigns appointment ids with kind letter a', async () => {
    await withTempVault(
      {
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Dentist cleaning #appointment 🗓️ 2026-09-29 15:00-16:00\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const assigned = await assignMissingIds({
          writer,
          vaultDir,
          relPaths: ['Tasks/Appointments.md'],
          hasId: () => false,
        });
        expect(assigned).toHaveLength(1);
        expect(assigned[0]!.id.startsWith('a')).toBe(true);
      },
    );
  });

  it('assigns fact ids with kind letter f in People/ notes, including plain bullets', async () => {
    await withTempVault(
      { 'People/Alex.md': '# Alex\n\n- Friend from college\n- Job hunting for PM roles\n' },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const assigned = await assignMissingIds({
          writer,
          vaultDir,
          relPaths: ['People/Alex.md'],
          hasId: () => false,
        });
        expect(assigned).toHaveLength(2);
        for (const a of assigned) expect(a.id.startsWith('f')).toBe(true);
      },
    );
  });

  it('assigns rule ids with kind letter r in _claudia/Rules.md', async () => {
    await withTempVault(
      {
        '_claudia/Rules.md':
          '---\nclaudia: rules\n---\n# Never-save rules\n\n- Nothing about therapy 🚫 therapy\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const assigned = await assignMissingIds({
          writer,
          vaultDir,
          relPaths: ['_claudia/Rules.md'],
          hasId: () => false,
        });
        expect(assigned).toHaveLength(1);
        expect(assigned[0]!.id.startsWith('r')).toBe(true);
      },
    );
  });

  it('assigns a default kind letter t to a plain list item in Tasks/ that is not a checkbox line', async () => {
    await withTempVault(
      { 'Tasks/To do.md': '# To do\n\n- A note without a checkbox\n' },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const assigned = await assignMissingIds({
          writer,
          vaultDir,
          relPaths: ['Tasks/To do.md'],
          hasId: () => false,
        });
        expect(assigned).toHaveLength(1);
        expect(assigned[0]!.id.startsWith('t')).toBe(true);
      },
    );
  });

  it('does not assign an id to a list item with an empty description in a managed note', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n- [ ]\n' }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const assigned = await assignMissingIds({
        writer,
        vaultDir,
        relPaths: ['Tasks/To do.md'],
        hasId: () => false,
      });
      expect(assigned).toHaveLength(0);
    });
  });

  it('outside id-managed paths, only assigns to open task lines with a valid reminder', async () => {
    await withTempVault(
      {
        'Inbox/Notes.md':
          '# Notes\n\n- [ ] Water plants ⏰ 2026-10-01 18:00\n- [ ] No reminder here\n- [x] Done already ⏰ 2026-09-01 09:00 ✅ 2026-09-01\n- Plain bullet, not a task\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const assigned = await assignMissingIds({
          writer,
          vaultDir,
          relPaths: ['Inbox/Notes.md'],
          hasId: () => false,
        });
        expect(assigned).toHaveLength(1);
        expect(assigned[0]!.id.startsWith('t')).toBe(true);
        const text = await readVaultFile(vaultDir, 'Inbox/Notes.md');
        expect(text).toContain(`Water plants ⏰ 2026-10-01 18:00 ^${assigned[0]!.id}`);
        expect(text).not.toContain('No reminder here ^');
        expect(text).not.toContain('Plain bullet, not a task ^');
      },
    );
  });

  it('skips generated and readme notes entirely', async () => {
    await withTempVault(
      {
        'Today.md':
          '---\nclaudia: generated\n---\n> Claudia rewrites this note.\n\n- [ ] Something\n',
        '_claudia/README.md': '---\nclaudia: readme\n---\n# How this works\n\n- A bullet\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const assigned = await assignMissingIds({
          writer,
          vaultDir,
          relPaths: ['Today.md', '_claudia/README.md'],
          hasId: () => false,
        });
        expect(assigned).toHaveLength(0);
      },
    );
  });

  it('does not assign ids to lines inside code fences', async () => {
    await withTempVault(
      { 'People/Alex.md': '# Alex\n\n```\n- Not a real fact\n```\n\n- A real fact\n' },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const assigned = await assignMissingIds({
          writer,
          vaultDir,
          relPaths: ['People/Alex.md'],
          hasId: () => false,
        });
        expect(assigned).toHaveLength(1);
        const text = await readVaultFile(vaultDir, 'People/Alex.md');
        expect(text).toContain('- Not a real fact\n');
        expect(text).toContain(`A real fact ^${assigned[0]!.id}`);
      },
    );
  });

  it('keeps ids unique across the vault (hasId) and within the same batch', async () => {
    const facts = Array.from({ length: 20 }, (_, i) => `- Fact number ${i}`).join('\n');
    await withTempVault({ 'People/Alex.md': `# Alex\n\n${facts}\n` }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const preexisting = new Set(['f0000', 'f1111']);
      const assigned = await assignMissingIds({
        writer,
        vaultDir,
        relPaths: ['People/Alex.md'],
        hasId: (id) => preexisting.has(id),
      });
      expect(assigned).toHaveLength(20);
      const ids = assigned.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length); // unique within the batch
      for (const id of ids) expect(preexisting.has(id)).toBe(false); // unique vs. the vault
    });
  });

  it('does one writer.editText call per file (single write even with several new ids)', async () => {
    await withTempVault(
      { 'People/Alex.md': '# Alex\n\n- Fact one\n- Fact two\n' },
      async (vaultDir) => {
        let editTextCalls = 0;
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const originalEditText = writer.editText.bind(writer);
        writer.editText = (relPath, edit, opts) => {
          editTextCalls += 1;
          return originalEditText(relPath, edit, opts);
        };
        await assignMissingIds({
          writer,
          vaultDir,
          relPaths: ['People/Alex.md'],
          hasId: () => false,
        });
        expect(editTextCalls).toBe(1);
      },
    );
  });

  it('dedups relPaths so a file is only processed once', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n- [ ] One thing\n' }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const assigned = await assignMissingIds({
        writer,
        vaultDir,
        relPaths: ['Tasks/To do.md', 'Tasks/To do.md'],
        hasId: () => false,
      });
      expect(assigned).toHaveLength(1);
    });
  });
});
