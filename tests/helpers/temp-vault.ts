// Test helper: a scratch vault directory under the OS temp dir, never the
// real vault. Synthetic content only.

import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export async function createTempVault(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claudia-vault-'));
  for (const [relPath, content] of Object.entries(files)) {
    await writeVaultFile(dir, relPath, content);
  }
  return dir;
}

export async function removeTempVault(vaultDir: string): Promise<void> {
  await rm(vaultDir, { recursive: true, force: true });
}

function toFullPath(vaultDir: string, relPath: string): string {
  return join(vaultDir, ...relPath.split('/'));
}

export async function writeVaultFile(
  vaultDir: string,
  relPath: string,
  content: string,
): Promise<void> {
  const full = toFullPath(vaultDir, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

export async function readVaultFile(vaultDir: string, relPath: string): Promise<string> {
  return readFile(toFullPath(vaultDir, relPath), 'utf8');
}

export async function vaultFileExists(vaultDir: string, relPath: string): Promise<boolean> {
  try {
    await stat(toFullPath(vaultDir, relPath));
    return true;
  } catch {
    return false;
  }
}

export async function setMtime(vaultDir: string, relPath: string, date: Date): Promise<void> {
  await utimes(toFullPath(vaultDir, relPath), date, date);
}

export async function statMtimeMs(vaultDir: string, relPath: string): Promise<number> {
  return (await stat(toFullPath(vaultDir, relPath))).mtimeMs;
}

/** Recursively lists every file (vault-relative POSIX path) under the vault, for temp-file-leak checks. */
export async function listAllFiles(vaultDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(relDir: string): Promise<void> {
    const full = relDir ? join(vaultDir, relDir) : vaultDir;
    const entries = await readdir(full, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk('');
  return out;
}
