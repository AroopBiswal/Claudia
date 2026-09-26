// Block ID assignment (vault-format.md section 6): after the quiet period,
// Claudia adds a block id to every list item in an id-managed note that
// lacks one, and to any open task line anywhere in the vault that carries
// a reminder. One writer.editText call per file.

import { isInCodeFence, parseNote, serializeNote } from '../vault/note.ts';
import { parseLine, setBlockId } from '../vault/line.ts';
import { extractItems, type VaultItem } from '../vault/items.ts';
import { isIdManagedPath, LAYOUT } from '../vault/layout.ts';
import { newBlockId, type IdKind } from '../vault/ids.ts';
import type { VaultWriter } from './writer.ts';

export interface AssignMissingIdsOptions {
  writer: VaultWriter;
  vaultDir: string;
  relPaths: string[];
  hasId: (id: string) => boolean;
}

function isOpenStatus(status: string | null): boolean {
  return status !== 'x' && status !== 'X' && status !== '-';
}

function kindLetterFor(relPath: string, item: VaultItem | undefined): IdKind {
  if (item) {
    if (item.kind === 'appointment') return 'a';
    if (item.kind === 'fact') return 'f';
    if (item.kind === 'rule') return 'r';
    return 't'; // task or follow_up
  }
  if (relPath.startsWith('People/') || relPath.startsWith('Memory/')) return 'f';
  if (relPath === LAYOUT.rules) return 'r';
  return 't';
}

export async function assignMissingIds(
  opts: AssignMissingIdsOptions,
): Promise<Array<{ path: string; id: string }>> {
  const { writer, relPaths, hasId } = opts;
  const usedInBatch = new Set<string>();
  const assigned: Array<{ path: string; id: string }> = [];
  const seen = new Set<string>();

  for (const relPath of relPaths) {
    if (seen.has(relPath)) continue;
    seen.add(relPath);

    const assignedForFile: string[] = [];

    await writer.editText(relPath, (text) => {
      const note = parseNote(text);
      if (
        note.frontmatter &&
        (note.frontmatter.claudia === 'generated' || note.frontmatter.claudia === 'readme')
      ) {
        return text;
      }

      const fenceFlags = isInCodeFence(note);
      const fmEnd = note.frontmatter ? note.frontmatter.endLine : -1;
      const managed = isIdManagedPath(relPath);
      const items = extractItems(relPath, note);
      const itemByLine = new Map<number, VaultItem>();
      for (const item of items) itemByLine.set(item.lineNo, item);

      const updatedLines = note.lines.slice();

      note.lines.forEach((line, idx) => {
        if (idx <= fmEnd) return;
        if (fenceFlags[idx]) return;

        const parsed = parseLine(line.text);
        if (!parsed.isListItem) return;
        if (parsed.blockId !== null) return;

        let qualifies: boolean;
        if (managed) {
          qualifies = parsed.description.trim().length > 0;
        } else {
          qualifies =
            parsed.isTask && isOpenStatus(parsed.status) && parsed.fields.reminder !== undefined;
        }
        if (!qualifies) return;

        const kind = kindLetterFor(relPath, itemByLine.get(idx));
        const id = newBlockId(kind, (candidate) => hasId(candidate) || usedInBatch.has(candidate));
        usedInBatch.add(id);
        assignedForFile.push(id);
        updatedLines[idx] = { ...line, text: setBlockId(line.text, id) };
      });

      if (assignedForFile.length === 0) return text;
      return serializeNote({ ...note, lines: updatedLines });
    });

    for (const id of assignedForFile) assigned.push({ path: relPath, id });
  }

  return assigned;
}
