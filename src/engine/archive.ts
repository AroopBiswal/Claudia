// Completed-items archive (vault-format.md section 5 "Done"): the nightly
// archive moves finished task lines out of Tasks/*.md into
// Tasks/Done/YYYY-MM.md, verbatim, keyed by the month of their completion
// date. Appends to the Done note before deleting from the source, so a
// crash leaves a duplicate, never a loss.

import { isInCodeFence, parseNote, serializeNote, type Note } from '../vault/note.ts';
import { parseLine, setField, setStatus } from '../vault/line.ts';
import { doneNotePath, LAYOUT } from '../vault/layout.ts';
import { doneNote } from '../vault/templates.ts';
import type { VaultWriter } from './writer.ts';

export interface ArchiveCompletedOptions {
  writer: VaultWriter;
  today: string; // YYYY-MM-DD, local
}

export interface ArchivedItem {
  id: string | null;
  from: string;
  to: string;
}

interface DatePart {
  y: number;
  m: number;
  d: number;
}

function parseYmd(date: string): DatePart {
  const [y, m, d] = date.split('-').map((s) => Number(s));
  return { y: y ?? 0, m: m ?? 1, d: d ?? 1 };
}

function daysBetween(a: string, b: string): number {
  const pa = parseYmd(a);
  const pb = parseYmd(b);
  const ua = Date.UTC(pa.y, pa.m - 1, pa.d);
  const ub = Date.UTC(pb.y, pb.m - 1, pb.d);
  return Math.round((ub - ua) / 86_400_000);
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Marks open appointment lines more than one day overdue as done, using the appointment date. */
async function convertOverdueAppointments(writer: VaultWriter, today: string): Promise<void> {
  await writer.editText(LAYOUT.appointments, (text) => {
    const note = parseNote(text);
    const fenceFlags = isInCodeFence(note);
    const fmEnd = note.frontmatter ? note.frontmatter.endLine : -1;
    let changedAny = false;

    const updatedLines = note.lines.map((line, idx) => {
      if (idx <= fmEnd || fenceFlags[idx]) return line;

      const parsed = parseLine(line.text);
      if (!parsed.isTask) return line;
      if (parsed.status === 'x' || parsed.status === 'X' || parsed.status === '-') return line;

      const appt = parsed.fields.appointment;
      if (!appt) return line;
      const apptDate = appt.slice(0, 10);
      if (daysBetween(apptDate, today) <= 1) return line;

      let raw = setStatus(line.text, 'x');
      raw = setField(raw, 'done', apptDate);
      changedAny = true;
      return { ...line, text: raw };
    });

    if (!changedAny) return text;
    return serializeNote({ ...note, lines: updatedLines });
  });
}

interface Candidate {
  idx: number;
  raw: string;
  blockId: string | null;
  month: string;
}

function collectCandidates(note: Note, today: string): Candidate[] {
  const fenceFlags = isInCodeFence(note);
  const fmEnd = note.frontmatter ? note.frontmatter.endLine : -1;
  const out: Candidate[] = [];

  note.lines.forEach((line, idx) => {
    if (idx <= fmEnd || fenceFlags[idx]) return;

    const parsed = parseLine(line.text);
    if (!parsed.isTask) return;

    const isDone = parsed.status === 'x' || parsed.status === 'X';
    const isCancelled = parsed.status === '-';
    if (!isDone && !isCancelled) return;

    const dateField = isDone ? parsed.fields.done : parsed.fields.cancelled;
    if (!dateField) return; // lines without a done date stay
    if (!(dateField < today)) return;

    out.push({ idx, raw: line.text, blockId: parsed.blockId, month: monthOf(dateField) });
  });

  return out;
}

async function archiveOneFile(
  writer: VaultWriter,
  path: string,
  today: string,
): Promise<ArchivedItem[]> {
  const text = await writer.read(path);
  if (text === null) return [];

  const note = parseNote(text);
  const candidates = collectCandidates(note, today);
  if (candidates.length === 0) return [];

  const byMonth = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const arr = byMonth.get(c.month) ?? [];
    arr.push(c);
    byMonth.set(c.month, arr);
  }

  // Append to Done first: a crash here leaves a duplicate, never a loss.
  for (const [month, group] of byMonth) {
    await writer.append(
      doneNotePath(month),
      group.map((c) => c.raw),
      { createWith: doneNote(month) },
    );
  }

  const blockIdSet = new Set(
    candidates.map((c) => c.blockId).filter((id): id is string => id !== null),
  );
  const idlessCandidates = candidates.filter((c) => c.blockId === null);

  await writer.editText(path, (currentText) => {
    const currentNote = parseNote(currentText);
    const fenceFlags = isInCodeFence(currentNote);
    const fmEnd = currentNote.frontmatter ? currentNote.frontmatter.endLine : -1;

    const keptLines = currentNote.lines.filter((line, idx) => {
      if (idx <= fmEnd || fenceFlags[idx]) return true;
      const parsed = parseLine(line.text);
      if (parsed.blockId && blockIdSet.has(parsed.blockId)) return false;
      if (!parsed.blockId && idlessCandidates.some((c) => c.idx === idx && c.raw === line.text)) {
        return false;
      }
      return true;
    });

    return serializeNote({ ...currentNote, lines: keptLines });
  });

  return candidates.map((c) => ({ id: c.blockId, from: path, to: doneNotePath(c.month) }));
}

export async function archiveCompleted(opts: ArchiveCompletedOptions): Promise<ArchivedItem[]> {
  const { writer, today } = opts;

  await convertOverdueAppointments(writer, today);

  const results: ArchivedItem[] = [];
  for (const path of [LAYOUT.todo, LAYOUT.followUps, LAYOUT.appointments]) {
    results.push(...(await archiveOneFile(writer, path, today)));
  }
  return results;
}
