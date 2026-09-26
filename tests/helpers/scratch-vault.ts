// A throwaway vault directory for engine tests: a temp dir under os.tmpdir(),
// never the real vault. Seeded with an initial file map, with write/remove
// helpers for simulating edits and a cleanup that removes the whole tree.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ScratchVault {
  dir: string;
  write(rel: string, text: string): Promise<void>;
  remove(rel: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function makeScratchVault(files: Record<string, string>): Promise<ScratchVault> {
  const dir = await mkdtemp(join(tmpdir(), 'claudia-vault-'));

  async function write(rel: string, text: string): Promise<void> {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text, 'utf8');
  }

  async function remove(rel: string): Promise<void> {
    await rm(join(dir, rel), { force: true });
  }

  async function cleanup(): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }

  for (const [rel, text] of Object.entries(files)) {
    await write(rel, text);
  }

  return { dir, write, remove, cleanup };
}
