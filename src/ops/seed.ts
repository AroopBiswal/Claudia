// Seeds the vault skeleton (docs/vault-format.md section 1): the folders and
// generated/editable notes Claudia needs, without touching anything else the
// owner already has in the vault. Called once by `claudia seed-vault` from
// the installer's terminal step (ops/install.sh step e), which has iCloud
// access even before the launchd service is granted Full Disk Access.
//
// Rules, matching docs/KICKOFF.md M8 and ops/install.sh's contract:
//   - never overwrite or modify a file that already exists;
//   - never delete anything;
//   - refuse (throw) if vaultDir doesn't exist, so a typo'd path can't
//     silently create a new, empty "vault" next to the real one.
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { SEED_FOLDERS, SEED_NOTES } from '../vault/templates.ts';

export interface SeedResult {
  /** Paths (relative to vaultDir) created by this call, folders first, then notes. */
  created: string[];
  /** Paths (relative to vaultDir) that already existed and were left untouched. */
  skipped: string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the SEED_FOLDERS and SEED_NOTES that don't already exist under `vaultDir`.
 * Idempotent: a second call with nothing changed in between reports everything as skipped.
 */
export async function seedVault(vaultDir: string): Promise<SeedResult> {
  if (!(await pathExists(vaultDir))) {
    throw new Error(`Vault directory does not exist: ${vaultDir}`);
  }
  const info = await stat(vaultDir);
  if (!info.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${vaultDir}`);
  }

  const created: string[] = [];
  const skipped: string[] = [];

  for (const folder of SEED_FOLDERS) {
    const full = join(vaultDir, folder);
    if (await pathExists(full)) {
      skipped.push(folder);
      continue;
    }
    await mkdir(full, { recursive: true });
    created.push(folder);
  }

  for (const note of SEED_NOTES) {
    const full = join(vaultDir, note.path);
    if (await pathExists(full)) {
      skipped.push(note.path);
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, note.content, 'utf8');
    created.push(note.path);
  }

  return { created, skipped };
}
