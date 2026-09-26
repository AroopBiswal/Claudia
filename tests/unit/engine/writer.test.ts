import { describe, expect, it } from 'vitest';
import { createVaultWriter } from '../../../src/engine/writer.ts';
import {
  createTempVault,
  listAllFiles,
  readVaultFile,
  removeTempVault,
  setMtime,
  statMtimeMs,
  vaultFileExists,
  writeVaultFile,
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

describe('createVaultWriter: append', () => {
  it('appends after the last list item, preserving CRLF, BOM and no trailing newline byte-for-byte elsewhere', async () => {
    const bom = '﻿';
    const original = `${bom}# To do\r\n\r\n- [ ] Existing task ^t0000\r\n`;
    await withTempVault({ 'Tasks/To do.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await writer.append('Tasks/To do.md', ['- [ ] New task ^t1111']);
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toBe(
        `${bom}# To do\r\n\r\n- [ ] Existing task ^t0000\r\n- [ ] New task ^t1111\r\n`,
      );
    });
  });

  it('appends on a new line at the end of the note when there are no list items, adding a trailing newline if the file lacked one', async () => {
    const original = '# Notes\n\nJust some prose, no list.';
    await withTempVault({ 'Tasks/To do.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await writer.append('Tasks/To do.md', ['- [ ] New task ^t1111']);
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toBe('# Notes\n\nJust some prose, no list.\n- [ ] New task ^t1111\n');
    });
  });

  it('creates the file and parent folders with createWith when missing', async () => {
    await withTempVault({}, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await writer.append('Tasks/Done/2026-09.md', ['- [x] Done thing ^t2222'], {
        createWith: '# Done 2026-09\n\n',
      });
      const text = await readVaultFile(vaultDir, 'Tasks/Done/2026-09.md');
      expect(text).toBe('# Done 2026-09\n\n- [x] Done thing ^t2222\n');
    });
  });

  it('inserts new lines using the dominant EOL even when appended after mixed content', async () => {
    const original = '# To do\r\n\r\n- [ ] One ^t0001\r\n- [ ] Two ^t0002\r\n';
    await withTempVault({ 'Tasks/To do.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await writer.append('Tasks/To do.md', ['- [ ] Three ^t0003']);
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toBe(original + '- [ ] Three ^t0003\r\n');
    });
  });
});

describe('createVaultWriter: editById', () => {
  it('replaces the target line in place and leaves the rest of the file byte-identical', async () => {
    const original = '# To do\n\n- [ ] One ^t0001\n- [ ] Two ^t0002\n- [ ] Three ^t0003\n';
    await withTempVault({ 'Tasks/To do.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const result = await writer.editById('Tasks/To do.md', 't0002', (raw) =>
        raw.replace('[ ]', '[x]'),
      );
      expect(result.found).toBe(true);
      expect(result.before).toBe('- [ ] Two ^t0002');
      expect(result.after).toBe('- [x] Two ^t0002');
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toBe('# To do\n\n- [ ] One ^t0001\n- [x] Two ^t0002\n- [ ] Three ^t0003\n');
    });
  });

  it('finds the line by id even after someone inserted lines above it', async () => {
    const original = '# To do\n\n- [ ] One ^t0001\n- [ ] Two ^t0002\n';
    await withTempVault({ 'Tasks/To do.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      // Simulate someone else inserting a line above the target between read and edit.
      await writeVaultFile(
        vaultDir,
        'Tasks/To do.md',
        '# To do\n\n- [ ] Zero ^t0000\n- [ ] One ^t0001\n- [ ] Two ^t0002\n',
      );
      const result = await writer.editById('Tasks/To do.md', 't0002', (raw) =>
        raw.replace('[ ]', '[x]'),
      );
      expect(result.found).toBe(true);
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toBe('# To do\n\n- [ ] Zero ^t0000\n- [ ] One ^t0001\n- [x] Two ^t0002\n');
    });
  });

  it('returns found:false when the id does not exist, without writing', async () => {
    const original = '# To do\n\n- [ ] One ^t0001\n';
    await withTempVault({ 'Tasks/To do.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const before = await statMtimeMs(vaultDir, 'Tasks/To do.md');
      const result = await writer.editById('Tasks/To do.md', 'tzzzz', (raw) => raw);
      expect(result.found).toBe(false);
      const after = await statMtimeMs(vaultDir, 'Tasks/To do.md');
      expect(after).toBe(before);
    });
  });

  it('deletes the line including its EOL when the edit callback returns null', async () => {
    const original = '# To do\n\n- [ ] One ^t0001\n- [ ] Two ^t0002\n- [ ] Three ^t0003\n';
    await withTempVault({ 'Tasks/To do.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const result = await writer.editById('Tasks/To do.md', 't0002', () => null);
      expect(result.found).toBe(true);
      expect(result.after).toBeNull();
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toBe('# To do\n\n- [ ] One ^t0001\n- [ ] Three ^t0003\n');
    });
  });
});

describe('createVaultWriter: insertAboveId', () => {
  it('inserts new lines directly above the target line using the file EOL', async () => {
    const original = '# To do\n\n- [ ] One ^t0001\n- [ ] Two ^t0002\n';
    await withTempVault({ 'Tasks/To do.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const found = await writer.insertAboveId('Tasks/To do.md', 't0002', [
        '- [ ] Inserted ^t9999',
      ]);
      expect(found).toBe(true);
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toBe('# To do\n\n- [ ] One ^t0001\n- [ ] Inserted ^t9999\n- [ ] Two ^t0002\n');
    });
  });

  it('returns false and does not write when the id is missing', async () => {
    const original = '# To do\n\n- [ ] One ^t0001\n';
    await withTempVault({ 'Tasks/To do.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const found = await writer.insertAboveId('Tasks/To do.md', 'tzzzz', ['- [ ] Nope ^t0000']);
      expect(found).toBe(false);
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toBe(original);
    });
  });
});

describe('createVaultWriter: editText', () => {
  it('does not write when the transform returns identical text', async () => {
    const original = '# Settings\n\n- Time zone: America/Los_Angeles\n';
    await withTempVault({ '_claudia/Settings.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const before = await statMtimeMs(vaultDir, '_claudia/Settings.md');
      const changed = await writer.editText('_claudia/Settings.md', (t) => t);
      expect(changed).toBe(false);
      const after = await statMtimeMs(vaultDir, '_claudia/Settings.md');
      expect(after).toBe(before);
    });
  });

  it('writes when the transform changes the text', async () => {
    const original = '# Settings\n\n- Time zone: America/Los_Angeles\n';
    await withTempVault({ '_claudia/Settings.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const changed = await writer.editText('_claudia/Settings.md', (t) =>
        t.replace('America/Los_Angeles', 'America/New_York'),
      );
      expect(changed).toBe(true);
      const text = await readVaultFile(vaultDir, '_claudia/Settings.md');
      expect(text).toContain('America/New_York');
    });
  });

  it('creates the file with createWith when missing before applying the transform', async () => {
    await withTempVault({}, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const changed = await writer.editText(
        '_claudia/Rules.md',
        (t) => t + '- New rule 🚫 x ^r0000\n',
        { createWith: '# Never-save rules\n\n' },
      );
      expect(changed).toBe(true);
      const text = await readVaultFile(vaultDir, '_claudia/Rules.md');
      expect(text).toBe('# Never-save rules\n\n- New rule 🚫 x ^r0000\n');
    });
  });
});

describe('createVaultWriter: rewrite', () => {
  it('skips the write when content is identical and reports false', async () => {
    const original = '# Today\n\nNothing.\n';
    await withTempVault({ 'Today.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const before = await statMtimeMs(vaultDir, 'Today.md');
      const wrote = await writer.rewrite('Today.md', original);
      expect(wrote).toBe(false);
      const after = await statMtimeMs(vaultDir, 'Today.md');
      expect(after).toBe(before);
    });
  });

  it('writes and reports true when content differs', async () => {
    await withTempVault({ 'Today.md': '# Today\n\nOld.\n' }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const wrote = await writer.rewrite('Today.md', '# Today\n\nNew.\n');
      expect(wrote).toBe(true);
      const text = await readVaultFile(vaultDir, 'Today.md');
      expect(text).toBe('# Today\n\nNew.\n');
    });
  });
});

describe('createVaultWriter: remove', () => {
  it('deletes the file', async () => {
    await withTempVault({ 'Tasks/To do 2.md': '# To do\n' }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await writer.remove('Tasks/To do 2.md');
      expect(await vaultFileExists(vaultDir, 'Tasks/To do 2.md')).toBe(false);
    });
  });

  it('is a no-op when the file does not exist', async () => {
    await withTempVault({}, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await expect(writer.remove('Tasks/Nope.md')).resolves.toBeUndefined();
    });
  });
});

describe('createVaultWriter: concurrency and atomicity', () => {
  it('runs 50 concurrent appends to one file strictly in order', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n' }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const appends = Array.from({ length: 50 }, (_, i) =>
        writer.append('Tasks/To do.md', [`- [ ] Task ${i} ^t${String(i).padStart(4, '0')}`]),
      );
      await Promise.all(appends);
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      const lines = text.trimEnd().split('\n').slice(2); // drop heading + blank line
      expect(lines).toHaveLength(50);
      lines.forEach((line, i) => {
        expect(line).toBe(`- [ ] Task ${i} ^t${String(i).padStart(4, '0')}`);
      });
    });
  });

  it('runs operations on different files concurrently (no cross-file serialization)', async () => {
    await withTempVault(
      { 'Tasks/To do.md': '# To do\n\n', 'Tasks/Follow-ups.md': '# Follow-ups\n\n' },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        await Promise.all([
          writer.append('Tasks/To do.md', ['- [ ] A ^t0001']),
          writer.append('Tasks/Follow-ups.md', ['- [ ] B ^t0002']),
        ]);
        expect(await readVaultFile(vaultDir, 'Tasks/To do.md')).toContain('A ^t0001');
        expect(await readVaultFile(vaultDir, 'Tasks/Follow-ups.md')).toContain('B ^t0002');
      },
    );
  });

  it('leaves no temp files behind after a successful write', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n- [ ] One ^t0001\n' }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await writer.append('Tasks/To do.md', ['- [ ] Two ^t0002']);
      const all = await listAllFiles(vaultDir);
      expect(all.some((f) => f.includes('.claudia-tmp'))).toBe(false);
    });
  });

  it('leaves no temp files behind when the edit callback throws', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n- [ ] One ^t0001\n' }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await expect(
        writer.editById('Tasks/To do.md', 't0001', () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const all = await listAllFiles(vaultDir);
      expect(all.some((f) => f.includes('.claudia-tmp'))).toBe(false);
      // The file itself is untouched.
      expect(await readVaultFile(vaultDir, 'Tasks/To do.md')).toBe('# To do\n\n- [ ] One ^t0001\n');
    });
  });

  it('leaves no temp files behind when editText throws', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n' }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await expect(
        writer.editText('Tasks/To do.md', () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const all = await listAllFiles(vaultDir);
      expect(all.some((f) => f.includes('.claudia-tmp'))).toBe(false);
    });
  });

  it('subsequent operations still work after a queued operation throws', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n' }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await expect(
        writer.editText('Tasks/To do.md', () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await writer.append('Tasks/To do.md', ['- [ ] Survives ^t0001']);
      expect(await readVaultFile(vaultDir, 'Tasks/To do.md')).toContain('Survives ^t0001');
    });
  });
});

describe('createVaultWriter: quiet period', () => {
  it('waits (via injected sleep) when the file was modified within the quiet window, then proceeds', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n- [ ] One ^t0001\n' }, async (vaultDir) => {
      const writeTime = await statMtimeMs(vaultDir, 'Tasks/To do.md');
      let fakeNow = writeTime + 500; // 500ms after the external write: within a 3000ms quiet window
      const sleeps: number[] = [];
      const writer = createVaultWriter({
        vaultDir,
        quietMs: 3000,
        maxWaitMs: 10000,
        now: () => new Date(fakeNow),
        sleep: (ms) => {
          sleeps.push(ms);
          fakeNow += ms;
          return Promise.resolve();
        },
      });
      await writer.append('Tasks/To do.md', ['- [ ] Two ^t0002']);
      expect(sleeps.length).toBeGreaterThan(0);
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2500 - 1);
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toContain('Two ^t0002');
    });
  });

  it('does not wait for its own last write', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n- [ ] One ^t0001\n' }, async (vaultDir) => {
      // Backdate so the first append's quiet-period check sees an old, quiet file.
      await setMtime(vaultDir, 'Tasks/To do.md', new Date(Date.now() - 60_000));
      const sleeps: number[] = [];
      let fakeNow = Date.now();
      const writer = createVaultWriter({
        vaultDir,
        quietMs: 3000,
        maxWaitMs: 10000,
        now: () => new Date(fakeNow),
        sleep: (ms) => {
          sleeps.push(ms);
          fakeNow += ms;
          return Promise.resolve();
        },
      });
      // First append: file is old, so no wait; this also records our own last write.
      await writer.append('Tasks/To do.md', ['- [ ] Two ^t0002']);
      expect(sleeps).toHaveLength(0);
      sleeps.length = 0;
      // Immediately follow with a second append: the file now looks freshly modified
      // (by us), but the writer recognizes it as its own last write and does not wait.
      await writer.append('Tasks/To do.md', ['- [ ] Three ^t0003']);
      expect(sleeps).toHaveLength(0);
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toContain('Two ^t0002');
      expect(text).toContain('Three ^t0003');
    });
  });

  it('proceeds after maxWaitMs when the file keeps looking freshly modified', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n- [ ] One ^t0001\n' }, async (vaultDir) => {
      let fakeNow = Date.now();
      const sleeps: number[] = [];
      const writer = createVaultWriter({
        vaultDir,
        quietMs: 3000,
        maxWaitMs: 10000,
        now: () => new Date(fakeNow),
        sleep: async (ms) => {
          sleeps.push(ms);
          fakeNow += ms;
          // Simulate an external process (iCloud sync) continuing to touch the
          // file, so it never goes quiet on its own.
          await setMtime(vaultDir, 'Tasks/To do.md', new Date(fakeNow));
        },
      });
      await writer.append('Tasks/To do.md', ['- [ ] Two ^t0002']);
      const totalWaited = sleeps.reduce((a, b) => a + b, 0);
      expect(totalWaited).toBeGreaterThanOrEqual(9000);
      expect(totalWaited).toBeLessThanOrEqual(10500);
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toContain('Two ^t0002');
    });
  });
});

describe('createVaultWriter: path safety', () => {
  it('rejects paths that escape the vault with ..', async () => {
    await withTempVault({}, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await expect(writer.read('../outside.md')).rejects.toThrow();
      await expect(writer.append('../outside.md', ['x'])).rejects.toThrow();
    });
  });

  it('rejects absolute paths', async () => {
    await withTempVault({}, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await expect(writer.read('/etc/passwd')).rejects.toThrow();
    });
  });

  it('rejects paths inside dot-folders', async () => {
    await withTempVault({}, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await expect(writer.read('.obsidian/workspace.json')).rejects.toThrow();
      await expect(writer.append('.trash/gone.md', ['x'])).rejects.toThrow();
    });
  });
});

describe('createVaultWriter: onWritten', () => {
  it('is called after a write that actually changed the file', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n' }, async (vaultDir) => {
      const written: string[] = [];
      const writer = createVaultWriter({
        vaultDir,
        quietMs: 0,
        maxWaitMs: 0,
        onWritten: (p) => written.push(p),
      });
      await writer.append('Tasks/To do.md', ['- [ ] One ^t0001']);
      expect(written).toEqual(['Tasks/To do.md']);
    });
  });

  it('is not called when editText makes no change', async () => {
    await withTempVault({ 'Tasks/To do.md': '# To do\n\n' }, async (vaultDir) => {
      const written: string[] = [];
      const writer = createVaultWriter({
        vaultDir,
        quietMs: 0,
        maxWaitMs: 0,
        onWritten: (p) => written.push(p),
      });
      await writer.editText('Tasks/To do.md', (t) => t);
      expect(written).toEqual([]);
    });
  });
});

describe('quiet period with a skewed clock', () => {
  it('does not stall when the file mtime is ahead of the clock', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudia-writer-skew-'));
    await fsp.writeFile(path.join(dir, 'a.md'), '- [ ] one ^t0001\n');
    const slept: number[] = [];
    const w = createVaultWriter({
      vaultDir: dir,
      now: () => new Date('2020-01-01T00:00:00Z'),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      quietMs: 3000,
    });
    await w.append('a.md', ['- [ ] two ^t0002']);
    expect(slept).toEqual([]);
    expect(await fsp.readFile(path.join(dir, 'a.md'), 'utf8')).toBe(
      '- [ ] one ^t0001\n- [ ] two ^t0002\n',
    );
  });
});
