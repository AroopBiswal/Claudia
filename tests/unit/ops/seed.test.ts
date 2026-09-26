import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedVault } from '../../../src/ops/seed.ts';
import { SEED_FOLDERS, SEED_NOTES } from '../../../src/vault/templates.ts';

const tempDirs: string[] = [];

function makeVaultDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-seed-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('seedVault', () => {
  it('refuses when the vault directory does not exist', async () => {
    const missing = join(tmpdir(), 'claudia-seed-test-does-not-exist-xyz');
    await expect(seedVault(missing)).rejects.toThrow(/does not exist/);
  });

  it('refuses when the vault path is not a directory', async () => {
    const dir = makeVaultDir();
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'hello');
    await expect(seedVault(file)).rejects.toThrow(/not a directory/);
  });

  it('creates every seed folder and note on a fresh vault', async () => {
    const dir = makeVaultDir();
    const result = await seedVault(dir);

    for (const folder of SEED_FOLDERS) {
      expect(result.created).toContain(folder);
    }
    for (const note of SEED_NOTES) {
      expect(result.created).toContain(note.path);
      expect(readFileSync(join(dir, note.path), 'utf8')).toBe(note.content);
    }
    expect(result.skipped).toEqual([]);
  });

  it('leaves the owner files it did not create untouched', async () => {
    const dir = makeVaultDir();
    mkdirSync(join(dir, 'Inbox'), { recursive: true });
    writeFileSync(join(dir, 'Inbox', 'Quick note.md'), '- an owner note\n');
    mkdirSync(join(dir, '.obsidian'), { recursive: true });
    writeFileSync(join(dir, '.obsidian', 'app.json'), '{"promptDelete":false}');
    writeFileSync(join(dir, 'Welcome.md'), '# Welcome\n\nMy own notes.\n');

    await seedVault(dir);

    expect(readFileSync(join(dir, 'Inbox', 'Quick note.md'), 'utf8')).toBe('- an owner note\n');
    expect(readFileSync(join(dir, '.obsidian', 'app.json'), 'utf8')).toBe('{"promptDelete":false}');
    expect(readFileSync(join(dir, 'Welcome.md'), 'utf8')).toBe('# Welcome\n\nMy own notes.\n');
  });

  it('never overwrites a seed note the owner has already edited', async () => {
    const dir = makeVaultDir();
    mkdirSync(join(dir, 'Tasks'), { recursive: true });
    const customToDo = '# To do\n\n- [ ] Something I already wrote ^t0000\n';
    writeFileSync(join(dir, 'Tasks', 'To do.md'), customToDo);

    const result = await seedVault(dir);

    expect(result.skipped).toContain('Tasks/To do.md');
    expect(result.created).not.toContain('Tasks/To do.md');
    expect(readFileSync(join(dir, 'Tasks', 'To do.md'), 'utf8')).toBe(customToDo);
  });

  it('is a no-op on a second run', async () => {
    const dir = makeVaultDir();
    await seedVault(dir);
    const second = await seedVault(dir);

    expect(second.created).toEqual([]);
    const expectedSkipped = [...SEED_FOLDERS, ...SEED_NOTES.map((n) => n.path)];
    for (const path of expectedSkipped) {
      expect(second.skipped).toContain(path);
    }
  });

  it('never deletes anything, even across two runs with owner edits in between', async () => {
    const dir = makeVaultDir();
    await seedVault(dir);

    // Owner adds their own folder and file after the first seed.
    mkdirSync(join(dir, 'Daily'), { recursive: true });
    writeFileSync(join(dir, 'Daily', '2026-09-26.md'), '# Daily log\n');

    await seedVault(dir);

    expect(readFileSync(join(dir, 'Daily', '2026-09-26.md'), 'utf8')).toBe('# Daily log\n');
  });
});
