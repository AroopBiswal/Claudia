// Semantic item extraction (vault-format.md sections 4-5): turns a parsed
// Note into the VaultItem records the index/services layers work with.

import { parseLine } from './line.ts';
import { isInCodeFence, type Note } from './note.ts';
import { LAYOUT, isIgnoredPath, noteBasename } from './layout.ts';

export type ItemKind = 'task' | 'follow_up' | 'appointment' | 'fact' | 'rule';
export type ItemStatus = 'open' | 'done' | 'cancelled';

export interface VaultItem {
  id: string | null;
  kind: ItemKind;
  path: string;
  lineNo: number;
  status: ItemStatus;
  statusChar: string | null;
  text: string;
  raw: string;
  reminder: string | null;
  snooze: string | null;
  appointment: { date: string; start: string; end: string | null } | null;
  due: string | null;
  created: string | null;
  done: string | null;
  cancelled: string | null;
  repeat: string | null;
  expires: string | null;
  keywords: string[];
  tags: string[];
  links: string[];
  people: string[];
  direction: 'waiting' | 'promised' | null;
}

const APPOINTMENT_VALUE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?:-(\d{2}:\d{2}))?$/;

function statusFromChar(statusChar: string | null): ItemStatus {
  if (statusChar === 'x' || statusChar === 'X') return 'done';
  if (statusChar === '-') return 'cancelled';
  return 'open';
}

export function extractItems(path: string, note: Note): VaultItem[] {
  if (isIgnoredPath(path)) return [];
  if (path.startsWith('Log/')) return [];
  if (
    note.frontmatter &&
    (note.frontmatter.claudia === 'generated' || note.frontmatter.claudia === 'readme')
  ) {
    return [];
  }

  const fenceFlags = isInCodeFence(note);
  const frontmatterEndLine = note.frontmatter ? note.frontmatter.endLine : -1;

  const inPeople = path.startsWith('People/');
  const inMemory = path.startsWith('Memory/');
  const inRules = path === LAYOUT.rules;
  const inFollowUps = path === LAYOUT.followUps;
  const personName = inPeople ? noteBasename(path) : null;

  const items: VaultItem[] = [];

  note.lines.forEach((line, idx) => {
    if (idx <= frontmatterEndLine) return;
    if (fenceFlags[idx]) return;

    const raw = line.text;
    const parsed = parseLine(raw);
    if (!parsed.isListItem) return;

    const links = parsed.links.map((l) => l.target);

    if (parsed.isTask) {
      const hasAppointment =
        parsed.tags.includes('appointment') || parsed.fields.appointment !== undefined;
      const waiting = parsed.tags.includes('waiting');
      const promised = parsed.tags.includes('promised');

      let kind: ItemKind;
      let direction: 'waiting' | 'promised' | null = null;
      if (hasAppointment) {
        kind = 'appointment';
      } else if (waiting || promised || inFollowUps) {
        kind = 'follow_up';
        direction = waiting ? 'waiting' : promised ? 'promised' : null;
      } else {
        kind = 'task';
      }

      let appointment: VaultItem['appointment'] = null;
      if (kind === 'appointment' && parsed.fields.appointment) {
        const m = APPOINTMENT_VALUE_RE.exec(parsed.fields.appointment);
        if (m && m[1] !== undefined && m[2] !== undefined) {
          appointment = { date: m[1], start: m[2], end: m[3] ?? null };
        }
      }

      items.push({
        id: parsed.blockId,
        kind,
        path,
        lineNo: idx,
        status: statusFromChar(parsed.status),
        statusChar: parsed.status,
        text: parsed.description,
        raw,
        reminder: parsed.fields.reminder ?? null,
        snooze: parsed.fields.snooze ?? null,
        appointment,
        due: parsed.fields.due ?? null,
        created: parsed.fields.created ?? null,
        done: parsed.fields.done ?? null,
        cancelled: parsed.fields.cancelled ?? null,
        repeat: parsed.fields.repeat ?? null,
        expires: parsed.fields.expires ?? null,
        keywords: [],
        tags: parsed.tags,
        links,
        people: [],
        direction,
      });
      return;
    }

    // Non-task list item: a fact in People/**, Memory/**, a rule in
    // _claudia/Rules.md, else plain text (not indexed as an item).
    let kind: ItemKind | null = null;
    if (inRules) kind = 'rule';
    else if (inPeople || inMemory) kind = 'fact';
    if (!kind) return;

    const keywords =
      kind === 'rule' && parsed.fields.keywords
        ? parsed.fields.keywords
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];

    const people = kind === 'fact' && personName ? [personName] : [];

    items.push({
      id: parsed.blockId,
      kind,
      path,
      lineNo: idx,
      status: 'open',
      statusChar: null,
      text: parsed.description,
      raw,
      reminder: null,
      snooze: null,
      appointment: null,
      due: null,
      created: null,
      done: null,
      cancelled: null,
      repeat: null,
      expires: parsed.fields.expires ?? null,
      keywords,
      tags: parsed.tags,
      links,
      people,
      direction: null,
    });
  });

  return items;
}
