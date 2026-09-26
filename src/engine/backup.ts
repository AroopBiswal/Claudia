// Nightly vault backup (Decision Log B11): a full copy of the vault under
// `~/.claudia/backups/vault-YYYY-MM-DD`, written atomically (temp dir then
// rename), skipping Obsidian workspace state, the trash and Claudia's own
// write-lock temp files. Backups older than `keepDays` are pruned.

import { randomBytes } from 'node:crypto';
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface RunBackupOptions {
  vaultDir: string;
  backupsDir: string;
  /** 'YYYY-MM-DD' local. */
  today: string;
  /** Backups this many days old or older are pruned; default 30. */
  keepDays?: number;
}

export interface BackupResult {
  /** The backup dir name just created ("vault-YYYY-MM-DD"), or null if today's already existed. */
  created: string | null;
  /** Backup dir names removed for being too old. */
  pruned: string[];
}

const DEFAULT_KEEP_DAYS = 30;
const VAULT_DIR_RE = /^vault-(\d{4}-\d{2}-\d{2})$/;

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

/** `.obsidian/workspace*.json`, anything under `.trash/`, and Claudia's `*.claudia-tmp` write-lock files. */
function isSkippedRelPath(rel: string): boolean {
  if (rel === '') return false;
  const posixRel = rel.split(sep).join('/');
  if (posixRel === '.trash' || posixRel.startsWith('.trash/')) return true;
  if (/^\.obsidian\/workspace[^/]*\.json$/.test(posixRel)) return true;
  if (posixRel.endsWith('.claudia-tmp')) return true;
  return false;
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const a = Date.UTC(fy ?? 0, (fm ?? 1) - 1, fd ?? 1);
  const b = Date.UTC(ty ?? 0, (tm ?? 1) - 1, td ?? 1);
  return Math.round((b - a) / 86_400_000);
}

async function pruneOldBackups(
  backupsDir: string,
  today: string,
  keepDays: number,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(backupsDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const pruned: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = VAULT_DIR_RE.exec(entry.name);
    if (!m) continue; // ignore unrelated entries
    const date = m[1];
    if (date === undefined) continue;
    if (daysBetween(date, today) >= keepDays) {
      await rm(join(backupsDir, entry.name), { recursive: true, force: true });
      pruned.push(entry.name);
    }
  }
  return pruned.sort();
}

/** Copies the vault to `backupsDir/vault-<today>` if not already there, then prunes old backups. */
export async function runBackup(opts: RunBackupOptions): Promise<BackupResult> {
  const { vaultDir, backupsDir, today, keepDays = DEFAULT_KEEP_DAYS } = opts;

  await mkdir(backupsDir, { recursive: true, mode: 0o700 });

  const targetName = `vault-${today}`;
  const targetPath = join(backupsDir, targetName);

  let created: string | null = null;
  if (!(await pathExists(targetPath))) {
    const tmpPath = join(backupsDir, `.${targetName}.${randomBytes(4).toString('hex')}.tmp`);
    await rm(tmpPath, { recursive: true, force: true });
    await cp(vaultDir, tmpPath, {
      recursive: true,
      dereference: false,
      filter: (src) => !isSkippedRelPath(relative(vaultDir, src)),
    });
    await rename(tmpPath, targetPath);
    created = targetName;
  }

  const pruned = await pruneOldBackups(backupsDir, today, keepDays);

  return { created, pruned };
}
