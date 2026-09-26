// Safe vault writes (vault-format.md section 10, docs/PLAN.md "Writing
// safely"): one promise queue per file, a quiet period before touching a
// file someone else just edited, and an atomic replace (temp file + rename)
// for every write. Every mutation re-reads the file, locates lines by block
// id or transforms the whole text, and never leaves a partial file behind.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isInCodeFence, noteEol, parseNote, serializeNote, type Note } from '../vault/note.ts';
import { parseLine } from '../vault/line.ts';
import { isIgnoredPath } from '../vault/layout.ts';

export interface EditResult {
  found: boolean;
  before?: string;
  after?: string | null;
}

export interface VaultWriter {
  read(relPath: string): Promise<string | null>;
  append(relPath: string, lines: string[], opts?: { createWith?: string }): Promise<void>;
  editById(relPath: string, id: string, edit: (raw: string) => string | null): Promise<EditResult>;
  insertAboveId(relPath: string, id: string, lines: string[]): Promise<boolean>;
  editText(
    relPath: string,
    edit: (text: string) => string,
    opts?: { createWith?: string },
  ): Promise<boolean>;
  rewrite(relPath: string, content: string): Promise<boolean>;
  remove(relPath: string): Promise<void>;
}

export interface CreateVaultWriterOptions {
  vaultDir: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  quietMs?: number;
  maxWaitMs?: number;
  onWritten?: (relPath: string) => void;
}

const DEFAULT_QUIET_MS = 3000;
const DEFAULT_MAX_WAIT_MS = 10000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** Rejects paths that escape the vault or point inside a dot-folder. */
function assertSafeRelPath(relPath: string): void {
  if (relPath.length === 0 || relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new Error(`unsafe vault path: ${relPath}`);
  }
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`unsafe vault path: ${relPath}`);
    }
  }
  if (isIgnoredPath(relPath)) {
    throw new Error(`unsafe vault path: ${relPath}`);
  }
}

function contentLineIndices(note: Note): { fenceFlags: boolean[]; fmEnd: number } {
  return {
    fenceFlags: isInCodeFence(note),
    fmEnd: note.frontmatter ? note.frontmatter.endLine : -1,
  };
}

/** Index at which new list items are appended: after the last list item, or at the end. */
function findAppendIndex(note: Note): number {
  const { fenceFlags, fmEnd } = contentLineIndices(note);
  let lastListItemIdx = -1;
  note.lines.forEach((line, idx) => {
    if (idx <= fmEnd) return;
    if (fenceFlags[idx]) return;
    if (parseLine(line.text).isListItem) lastListItemIdx = idx;
  });
  return lastListItemIdx >= 0 ? lastListItemIdx + 1 : note.lines.length;
}

function findLineIndexById(note: Note, id: string): number {
  const { fenceFlags, fmEnd } = contentLineIndices(note);
  let found = -1;
  note.lines.forEach((line, idx) => {
    if (found !== -1) return;
    if (idx <= fmEnd) return;
    if (fenceFlags[idx]) return;
    if (parseLine(line.text).blockId === id) found = idx;
  });
  return found;
}

export function createVaultWriter(opts: CreateVaultWriterOptions): VaultWriter {
  const vaultDir = opts.vaultDir;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? defaultSleep;
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const onWritten = opts.onWritten;

  const queues = new Map<string, Promise<unknown>>();
  const ownWrites = new Map<string, { mtimeMs: number; size: number }>();

  function fullPath(relPath: string): string {
    return join(vaultDir, ...relPath.split('/'));
  }

  function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    const settledPrev = prev.then(
      () => undefined,
      () => undefined,
    );
    const result = settledPrev.then(fn);
    queues.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  async function safeReadFile(full: string): Promise<string | null> {
    try {
      return await readFile(full, 'utf8');
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async function waitForQuiet(full: string, relPath: string): Promise<void> {
    const start = now().getTime();
    for (;;) {
      let st;
      try {
        st = await stat(full);
      } catch {
        return; // file does not exist yet: nothing to wait for
      }
      const own = ownWrites.get(relPath);
      if (own && own.mtimeMs === st.mtimeMs && own.size === st.size) return;
      const age = now().getTime() - st.mtimeMs;
      if (age >= quietMs) return;
      const elapsed = now().getTime() - start;
      if (elapsed >= maxWaitMs) return;
      const waitMs = Math.max(1, Math.min(quietMs - age, maxWaitMs - elapsed));
      await sleep(waitMs);
    }
  }

  /** Atomic replace: temp file in the same folder, then rename; preserves mode; cleans up on error. */
  async function atomicWrite(
    full: string,
    content: string,
  ): Promise<{ mtimeMs: number; size: number }> {
    const dir = dirname(full);
    await mkdir(dir, { recursive: true });

    let mode: number | undefined;
    try {
      mode = (await stat(full)).mode;
    } catch {
      mode = undefined;
    }

    const tmpPath = join(dir, `.${basename(full)}.${randomBytes(4).toString('hex')}.claudia-tmp`);
    try {
      await writeFile(tmpPath, content, mode !== undefined ? { mode } : undefined);
      await rename(tmpPath, full);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }

    const st = await stat(full);
    return { mtimeMs: st.mtimeMs, size: st.size };
  }

  function recordOwnWrite(relPath: string, result: { mtimeMs: number; size: number }): void {
    ownWrites.set(relPath, result);
  }

  async function read(relPath: string): Promise<string | null> {
    assertSafeRelPath(relPath);
    return enqueue(relPath, () => safeReadFile(fullPath(relPath)));
  }

  async function append(
    relPath: string,
    lines: string[],
    appendOpts?: { createWith?: string },
  ): Promise<void> {
    assertSafeRelPath(relPath);
    return enqueue(relPath, async () => {
      const full = fullPath(relPath);
      await waitForQuiet(full, relPath);

      const existing = await safeReadFile(full);
      const text = existing ?? appendOpts?.createWith ?? '';
      const note = parseNote(text);
      const eol = note.lines.length > 0 ? noteEol(note) : '\n';
      const insertAt = findAppendIndex(note);

      const updatedLines = note.lines.slice();
      if (insertAt === updatedLines.length) {
        const lastIdx = updatedLines.length - 1;
        const last = lastIdx >= 0 ? updatedLines[lastIdx] : undefined;
        if (last && last.eol === '') {
          updatedLines[lastIdx] = { ...last, eol };
        }
      }
      updatedLines.splice(insertAt, 0, ...lines.map((l) => ({ text: l, eol })));

      const content = serializeNote({ ...note, lines: updatedLines });
      const result = await atomicWrite(full, content);
      recordOwnWrite(relPath, result);
      onWritten?.(relPath);
    });
  }

  async function editById(
    relPath: string,
    id: string,
    edit: (raw: string) => string | null,
  ): Promise<EditResult> {
    assertSafeRelPath(relPath);
    return enqueue(relPath, async () => {
      const full = fullPath(relPath);
      await waitForQuiet(full, relPath);

      const text = await safeReadFile(full);
      if (text === null) return { found: false };

      const note = parseNote(text);
      const idx = findLineIndexById(note, id);
      if (idx === -1) return { found: false };

      const before = note.lines[idx]!.text;
      const after = edit(before);

      if (after === before) {
        return { found: true, before, after };
      }

      const updatedLines = note.lines.slice();
      if (after === null) {
        updatedLines.splice(idx, 1);
      } else {
        updatedLines[idx] = { ...updatedLines[idx]!, text: after };
      }

      const content = serializeNote({ ...note, lines: updatedLines });
      const result = await atomicWrite(full, content);
      recordOwnWrite(relPath, result);
      onWritten?.(relPath);
      return { found: true, before, after };
    });
  }

  async function insertAboveId(relPath: string, id: string, lines: string[]): Promise<boolean> {
    assertSafeRelPath(relPath);
    return enqueue(relPath, async () => {
      const full = fullPath(relPath);
      await waitForQuiet(full, relPath);

      const text = await safeReadFile(full);
      if (text === null) return false;

      const note = parseNote(text);
      const idx = findLineIndexById(note, id);
      if (idx === -1) return false;

      const eol = noteEol(note);
      const updatedLines = note.lines.slice();
      updatedLines.splice(idx, 0, ...lines.map((l) => ({ text: l, eol })));

      const content = serializeNote({ ...note, lines: updatedLines });
      const result = await atomicWrite(full, content);
      recordOwnWrite(relPath, result);
      onWritten?.(relPath);
      return true;
    });
  }

  async function editText(
    relPath: string,
    edit: (text: string) => string,
    editOpts?: { createWith?: string },
  ): Promise<boolean> {
    assertSafeRelPath(relPath);
    return enqueue(relPath, async () => {
      const full = fullPath(relPath);
      await waitForQuiet(full, relPath);

      const existing = await safeReadFile(full);
      const existed = existing !== null;
      const text = existing ?? editOpts?.createWith ?? '';
      const updated = edit(text);

      if (existed && updated === text) return false;

      const result = await atomicWrite(full, updated);
      recordOwnWrite(relPath, result);
      onWritten?.(relPath);
      return true;
    });
  }

  async function rewrite(relPath: string, content: string): Promise<boolean> {
    assertSafeRelPath(relPath);
    return enqueue(relPath, async () => {
      const full = fullPath(relPath);
      await waitForQuiet(full, relPath);

      const existing = await safeReadFile(full);
      if (existing === content) return false;

      const result = await atomicWrite(full, content);
      recordOwnWrite(relPath, result);
      onWritten?.(relPath);
      return true;
    });
  }

  async function remove(relPath: string): Promise<void> {
    assertSafeRelPath(relPath);
    return enqueue(relPath, async () => {
      const full = fullPath(relPath);
      await waitForQuiet(full, relPath);
      await rm(full, { force: true });
      ownWrites.delete(relPath);
      onWritten?.(relPath);
    });
  }

  return { read, append, editById, insertAboveId, editText, rewrite, remove };
}
