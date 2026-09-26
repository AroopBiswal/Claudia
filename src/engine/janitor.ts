// iCloud conflict-copy janitor (vault-format.md section 9): finds
// `<name> <N>.md` files that share at least one block id with `<name>.md`
// in the same folder, merges them into the original by block id, and
// removes the copy.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isInCodeFence,
  parseNote,
  serializeNote,
  type Note,
  type NoteLine,
} from '../vault/note.ts';
import { parseLine } from '../vault/line.ts';
import { conflictCopyBase, isIgnoredPath } from '../vault/layout.ts';
import type { VaultWriter } from './writer.ts';

export interface MergeReport {
  copy: string;
  original: string;
  linesKept: number;
  linesAdded: number;
  linesFromCopy: number;
}

export interface RunJanitorOptions {
  vaultDir: string;
  writer: VaultWriter;
  relPaths?: string[];
}

interface ContentEntry {
  idx: number;
  blockId: string | null;
  raw: string;
}

function contentEntries(note: Note): ContentEntry[] {
  const fenceFlags = isInCodeFence(note);
  const fmEnd = note.frontmatter ? note.frontmatter.endLine : -1;
  const entries: ContentEntry[] = [];
  note.lines.forEach((line, idx) => {
    if (idx <= fmEnd) return;
    if (fenceFlags[idx]) return;
    entries.push({ idx, blockId: parseLine(line.text).blockId, raw: line.text });
  });
  return entries;
}

function isDoneOrCancelled(raw: string): boolean {
  const status = parseLine(raw).status;
  return status === 'x' || status === 'X' || status === '-';
}

function isHeadingLine(raw: string): boolean {
  return /^\s{0,3}#{1,6}(\s|$)/.test(raw);
}

async function listMarkdownFiles(vaultDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(relDir: string): Promise<void> {
    const full = relDir ? join(vaultDir, relDir) : vaultDir;
    const entries = await readdir(full, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isIgnoredPath(rel) || (entry.isDirectory() && entry.name.startsWith('.'))) continue;
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile() && rel.endsWith('.md')) {
        out.push(rel);
      }
    }
  }
  await walk('');
  return out;
}

export async function runJanitor(opts: RunJanitorOptions): Promise<MergeReport[]> {
  const { vaultDir, writer } = opts;
  const candidatePaths = opts.relPaths
    ? opts.relPaths.filter((p) => conflictCopyBase(p) !== null)
    : (await listMarkdownFiles(vaultDir)).filter((p) => conflictCopyBase(p) !== null);

  const reports: MergeReport[] = [];

  for (const copyPath of candidatePaths) {
    const basePath = conflictCopyBase(copyPath);
    if (!basePath) continue;

    const originalFull = join(vaultDir, ...basePath.split('/'));
    const copyFull = join(vaultDir, ...copyPath.split('/'));

    let originalStat;
    let copyStat;
    try {
      originalStat = await stat(originalFull);
    } catch {
      continue; // no original: leave the copy alone
    }
    try {
      copyStat = await stat(copyFull);
    } catch {
      continue; // copy vanished under us
    }

    const copyText = await readFile(copyFull, 'utf8');
    const copyNote = parseNote(copyText);
    const copyEntries = contentEntries(copyNote);
    const copyIds = new Set(
      copyEntries.map((e) => e.blockId).filter((id): id is string => id !== null),
    );
    if (copyIds.size === 0) continue;

    const peekText = await readFile(originalFull, 'utf8');
    const peekIds = new Set(
      contentEntries(parseNote(peekText))
        .map((e) => e.blockId)
        .filter((id): id is string => id !== null),
    );
    const sharesId = [...copyIds].some((id) => peekIds.has(id));
    if (!sharesId) continue; // e.g. an unrelated "Plan 2.md" next to "Plan.md"

    let linesKept = 0;
    let linesAdded = 0;
    let linesFromCopy = 0;

    await writer.editText(basePath, (originalText) => {
      linesKept = 0;
      linesAdded = 0;
      linesFromCopy = 0;

      const originalNote = parseNote(originalText);
      const fenceFlags = isInCodeFence(originalNote);
      const fmEnd = originalNote.frontmatter ? originalNote.frontmatter.endLine : -1;
      const dominantEolLine = originalNote.lines.find((l) => l.eol !== '');
      const eol = dominantEolLine ? dominantEolLine.eol : '\n';

      const updatedLines: NoteLine[] = originalNote.lines.slice();
      const idToIdx = new Map<string, number>();
      updatedLines.forEach((line, idx) => {
        if (idx <= fmEnd || fenceFlags[idx]) return;
        const blockId = parseLine(line.text).blockId;
        if (blockId) idToIdx.set(blockId, idx);
      });

      function shiftIndicesFrom(pos: number): void {
        for (const [id, idx] of idToIdx) {
          if (idx >= pos) idToIdx.set(id, idx + 1);
        }
      }

      let cursorIdx: number | null = null;

      for (const entry of copyEntries) {
        if (entry.blockId && idToIdx.has(entry.blockId)) {
          // Present in both: done/cancelled wins over open; else newer mtime wins.
          const origIdx = idToIdx.get(entry.blockId)!;
          const origRaw = updatedLines[origIdx]!.text;
          const origDone = isDoneOrCancelled(origRaw);
          const copyDone = isDoneOrCancelled(entry.raw);

          let winner: 'original' | 'copy';
          if (origDone && !copyDone) winner = 'original';
          else if (copyDone && !origDone) winner = 'copy';
          else winner = copyStat.mtimeMs > originalStat.mtimeMs ? 'copy' : 'original';

          if (winner === 'copy') {
            updatedLines[origIdx] = { ...updatedLines[origIdx]!, text: entry.raw };
            linesFromCopy++;
          } else {
            linesKept++;
          }
          cursorIdx = origIdx;
          continue;
        }

        if (entry.blockId) {
          // Block id only in the copy: insert after its nearest preceding
          // neighbor that exists in the original (by the copy's order), else append.
          const insertAt: number = cursorIdx !== null ? cursorIdx + 1 : updatedLines.length;
          updatedLines.splice(insertAt, 0, { text: entry.raw, eol });
          shiftIndicesFrom(insertAt);
          linesAdded++;
          if (cursorIdx !== null) cursorIdx = insertAt;
          continue;
        }

        // No block id: only append non-blank lines that aren't headings already present.
        if (entry.raw.trim() === '') continue;
        if (isHeadingLine(entry.raw)) {
          const already = updatedLines.some((l) => l.text.trim() === entry.raw.trim());
          if (already) continue;
        }
        updatedLines.push({ text: entry.raw, eol });
        linesAdded++;
      }

      return serializeNote({ ...originalNote, lines: updatedLines });
    });

    await writer.remove(copyPath);

    reports.push({ copy: copyPath, original: basePath, linesKept, linesAdded, linesFromCopy });
  }

  return reports;
}
