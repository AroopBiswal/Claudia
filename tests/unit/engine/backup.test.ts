import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBackup } from '../../../src/engine/backup.ts';
import {
  createTempVault,
  readVaultFile,
  removeTempVault,
  vaultFileExists,
} from '../../helpers/temp-vault.ts';

let vaultDir: string | undefined;
let backupsDir: string | undefined;

afterEach(async () => {
  if (vaultDir) await removeTempVault(vaultDir);
  if (backupsDir) await removeTempVault(backupsDir);
  vaultDir = undefined;
  backupsDir = undefined;
});

async function makeBackupsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'claudia-backups-'));
}

describe('runBackup', () => {
  it('copies the vault into backupsDir/vault-<today>, atomically, leaving no temp dir behind', async () => {
    vaultDir = await createTempVault({
      'Tasks/To do.md': '# To do\n\n- [ ] Water plants ^t0001\n',
      'People/Alex.md': '# Alex\n\n- Friend from college ^f0001\n',
    });
    backupsDir = await makeBackupsDir();

    const result = await runBackup({ vaultDir, backupsDir, today: '2026-09-26' });
    expect(result.created).toBe('vault-2026-09-26');
    expect(result.pruned).toEqual([]);

    const backupTodo = await readVaultFile(join(backupsDir, 'vault-2026-09-26'), 'Tasks/To do.md');
    expect(backupTodo).toBe('# To do\n\n- [ ] Water plants ^t0001\n');
    const backupAlex = await readVaultFile(join(backupsDir, 'vault-2026-09-26'), 'People/Alex.md');
    expect(backupAlex).toBe('# Alex\n\n- Friend from college ^f0001\n');

    const entries = await readdir(backupsDir);
    expect(entries).toEqual(['vault-2026-09-26']); // no leftover .tmp dir
  });

  it('creates backupsDir with mode 0700', async () => {
    vaultDir = await createTempVault({ 'Tasks/To do.md': '# To do\n\n' });
    backupsDir = join(await mkdtemp(join(tmpdir(), 'claudia-backups-parent-')), 'backups');

    await runBackup({ vaultDir, backupsDir, today: '2026-09-26' });

    const st = await stat(backupsDir);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('skips .obsidian/workspace*.json, .trash/ and *.claudia-tmp files', async () => {
    vaultDir = await createTempVault({
      'Tasks/To do.md': '# To do\n\n',
      '.obsidian/workspace.json': '{"leftover": true}',
      '.obsidian/workspace-mobile.json': '{"leftover": true}',
      '.obsidian/app.json': '{"keep": true}',
      '.trash/deleted.md': '# gone\n',
      'Tasks/.To do.md.abcd1234.claudia-tmp': 'partial write',
    });
    backupsDir = await makeBackupsDir();

    const result = await runBackup({ vaultDir, backupsDir, today: '2026-09-26' });
    const backupDir = join(backupsDir, result.created!);

    expect(await vaultFileExists(backupDir, 'Tasks/To do.md')).toBe(true);
    expect(await vaultFileExists(backupDir, '.obsidian/app.json')).toBe(true);
    expect(await vaultFileExists(backupDir, '.obsidian/workspace.json')).toBe(false);
    expect(await vaultFileExists(backupDir, '.obsidian/workspace-mobile.json')).toBe(false);
    expect(await vaultFileExists(backupDir, '.trash/deleted.md')).toBe(false);
    expect(await vaultFileExists(backupDir, '.trash')).toBe(false);
    expect(await vaultFileExists(backupDir, 'Tasks/.To do.md.abcd1234.claudia-tmp')).toBe(false);
  });

  it("is a no-op (skip) when today's backup already exists", async () => {
    vaultDir = await createTempVault({ 'Tasks/To do.md': '# To do\n\n- [ ] Original ^t0001\n' });
    backupsDir = await makeBackupsDir();

    const first = await runBackup({ vaultDir, backupsDir, today: '2026-09-26' });
    expect(first.created).toBe('vault-2026-09-26');

    // Change the live vault; a second run on the same day must not overwrite the snapshot.
    await writeFile(join(vaultDir, 'Tasks', 'To do.md'), '# To do\n\n- [ ] Changed later ^t0001\n');

    const second = await runBackup({ vaultDir, backupsDir, today: '2026-09-26' });
    expect(second.created).toBeNull();

    const snapshot = await readVaultFile(join(backupsDir, 'vault-2026-09-26'), 'Tasks/To do.md');
    expect(snapshot).toBe('# To do\n\n- [ ] Original ^t0001\n');
  });

  it('prunes vault-YYYY-MM-DD dirs older than keepDays and ignores unrelated entries', async () => {
    vaultDir = await createTempVault({ 'Tasks/To do.md': '# To do\n\n' });
    backupsDir = await makeBackupsDir();

    await mkdir(join(backupsDir, 'vault-2026-08-01'), { recursive: true }); // very old
    await mkdir(join(backupsDir, 'vault-2026-09-10'), { recursive: true }); // exactly at the edge
    await mkdir(join(backupsDir, 'vault-2026-09-20'), { recursive: true }); // recent, kept
    await mkdir(join(backupsDir, 'not-a-backup'), { recursive: true }); // unrelated dir, ignored
    await writeFile(join(backupsDir, 'README.txt'), 'not a backup either'); // unrelated file, ignored

    const result = await runBackup({
      vaultDir,
      backupsDir,
      today: '2026-09-26',
      keepDays: 16,
    });

    expect(result.created).toBe('vault-2026-09-26');
    expect(result.pruned.sort()).toEqual(['vault-2026-08-01', 'vault-2026-09-10']);

    const remaining = (await readdir(backupsDir)).sort();
    expect(remaining).toEqual(
      ['README.txt', 'not-a-backup', 'vault-2026-09-20', 'vault-2026-09-26'].sort(),
    );
  });

  it('defaults to a 30-day retention window', async () => {
    vaultDir = await createTempVault({ 'Tasks/To do.md': '# To do\n\n' });
    backupsDir = await makeBackupsDir();

    await mkdir(join(backupsDir, 'vault-2026-08-01'), { recursive: true }); // 56 days before 09-26
    await mkdir(join(backupsDir, 'vault-2026-08-28'), { recursive: true }); // 29 days before, kept

    const result = await runBackup({ vaultDir, backupsDir, today: '2026-09-26' });
    expect(result.pruned).toEqual(['vault-2026-08-01']);
    expect(await vaultFileExists(backupsDir, 'vault-2026-08-28')).toBe(true);
  });
});
