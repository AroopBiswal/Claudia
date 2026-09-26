// Lossless line-level model for list items, tasks, facts and rules
// (vault-format.md section 4). Pure string surgery: every edit function
// changes only the bytes it needs to and leaves the rest of the line intact.

export type FieldName =
  | 'reminder'
  | 'snooze'
  | 'appointment'
  | 'expires'
  | 'keywords'
  | 'repeat'
  | 'created'
  | 'start'
  | 'scheduled'
  | 'due'
  | 'cancelled'
  | 'done';

export const FIELD_EMOJI: Record<FieldName, string> = {
  reminder: '⏰',
  snooze: '💤',
  appointment: '🗓️',
  expires: '⌛',
  keywords: '🚫',
  repeat: '🔁',
  created: '➕',
  start: '🛫',
  scheduled: '⏳',
  due: '📅',
  cancelled: '❌',
  done: '✅',
};

export const CANONICAL_ORDER: FieldName[] = [
  'reminder',
  'snooze',
  'appointment',
  'expires',
  'keywords',
  'repeat',
  'created',
  'start',
  'scheduled',
  'due',
  'cancelled',
  'done',
];

const PRIORITY_EMOJIS = ['⏫', '🔼', '🔽', '🔺', '⏬'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const APPOINTMENT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(-\d{2}:\d{2})?$/;

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;
const DATETIME_PREFIX_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
const APPOINTMENT_PREFIX_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(-\d{2}:\d{2})?/;

const FREE_TEXT_FIELDS = new Set<FieldName>(['keywords', 'repeat']);
const DATETIME_FIELDS = new Set<FieldName>(['reminder', 'snooze']);

export interface WikiLink {
  target: string;
  anchor: string | null;
  alias: string | null;
}

export interface ParsedLine {
  raw: string;
  indent: string;
  bullet: string | null;
  status: string | null;
  isListItem: boolean;
  isTask: boolean;
  description: string;
  fields: Partial<Record<FieldName, string>>;
  priority: string | null;
  tags: string[];
  links: WikiLink[];
  blockId: string | null;
}

export function isValidFieldValue(name: FieldName, value: string): boolean {
  if (FREE_TEXT_FIELDS.has(name)) return value.trim().length > 0;
  if (DATETIME_FIELDS.has(name)) return DATETIME_RE.test(value);
  if (name === 'appointment') return APPOINTMENT_RE.test(value);
  return DATE_RE.test(value);
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let idx = 0;
  while (idx <= haystack.length) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    positions.push(found);
    idx = found + Math.max(needle.length, 1);
  }
  return positions;
}

function precededByWhitespaceOrStart(content: string, pos: number): boolean {
  if (pos === 0) return true;
  const prev = content[pos - 1] ?? '';
  return /\s/.test(prev);
}

interface FieldCandidate {
  name: FieldName;
  pos: number;
  len: number;
}

function findFieldCandidates(content: string): FieldCandidate[] {
  const raw: FieldCandidate[] = [];
  for (const name of CANONICAL_ORDER) {
    if (name === 'appointment') {
      for (const pos of findAllOccurrences(content, '🗓️')) {
        raw.push({ name, pos, len: '🗓️'.length });
      }
      for (const pos of findAllOccurrences(content, '🗓')) {
        if (!raw.some((r) => r.name === 'appointment' && r.pos === pos)) {
          raw.push({ name, pos, len: '🗓'.length });
        }
      }
    } else {
      const emoji = FIELD_EMOJI[name];
      for (const pos of findAllOccurrences(content, emoji)) {
        raw.push({ name, pos, len: emoji.length });
      }
    }
  }

  const filtered = raw.filter((m) => precededByWhitespaceOrStart(content, m.pos));
  filtered.sort((a, b) => a.pos - b.pos || b.len - a.len);

  const dedup: FieldCandidate[] = [];
  const seenPos = new Set<number>();
  for (const m of filtered) {
    if (seenPos.has(m.pos)) continue;
    seenPos.add(m.pos);
    dedup.push(m);
  }
  return dedup;
}

interface PriorityCandidate {
  pos: number;
  len: number;
  emoji: string;
}

function findPriorityCandidates(content: string): PriorityCandidate[] {
  const raw: PriorityCandidate[] = [];
  for (const emoji of PRIORITY_EMOJIS) {
    for (const pos of findAllOccurrences(content, emoji)) {
      raw.push({ pos, len: emoji.length, emoji });
    }
  }
  return raw
    .filter((m) => precededByWhitespaceOrStart(content, m.pos))
    .sort((a, b) => a.pos - b.pos);
}

function findExcludedSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const wiki = /\[\[[^\]]*\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wiki.exec(content))) {
    spans.push([m.index, m.index + m[0].length]);
  }
  const mdLink = /\[[^\]]*\]\([^)]*\)/g;
  while ((m = mdLink.exec(content))) {
    spans.push([m.index, m.index + m[0].length]);
  }
  const url = /https?:\/\/\S+/g;
  while ((m = url.exec(content))) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function inSpans(pos: number, spans: Array<[number, number]>): boolean {
  return spans.some(([s, e]) => pos >= s && pos < e);
}

interface TagCandidate {
  pos: number;
  len: number;
  value: string;
}

const TAG_RE = /(?<![\p{L}\p{N}_])#([\p{L}\p{N}_/-]+)/gu;

function findTagCandidates(content: string): TagCandidate[] {
  const spans = findExcludedSpans(content);
  const results: TagCandidate[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(content))) {
    const value = m[1] ?? '';
    if (/^\d+$/.test(value)) continue;
    if (inSpans(m.index, spans)) continue;
    results.push({ pos: m.index, len: m[0].length, value });
  }
  return results;
}

const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g;

function findLinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  WIKI_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_LINK_RE.exec(content))) {
    links.push({
      target: (m[1] ?? '').trim(),
      anchor: m[2] !== undefined ? m[2] : null,
      alias: m[3] !== undefined ? m[3] : null,
    });
  }
  return links;
}

interface FieldSpan {
  tokenStart: number;
  valueStart: number;
  valueEnd: number;
}

interface LineAnalysis {
  raw: string;
  indent: string;
  bullet: string | null;
  isListItem: boolean;
  isTask: boolean;
  status: string | null;
  statusSpan: [number, number] | null;
  contentStart: number;
  contentEnd: number;
  blockId: string | null;
  fields: Partial<Record<FieldName, string>>;
  fieldSpans: Partial<Record<FieldName, FieldSpan>>;
  priority: string | null;
  prioritySpan: [number, number] | null;
  tags: string[];
  links: WikiLink[];
  description: string;
}

const BULLET_RE = /^(-|\*|\+|\d+[.)])( )/;
const STATUS_RE = /^\[(.)\](?: |$)/;
const BLOCK_ID_RE = /\s\^([A-Za-z0-9-]+)(\s*)$/;

function analyzeLine(raw: string): LineAnalysis {
  const indentMatch = /^[ \t]*/.exec(raw);
  const indent = indentMatch ? indentMatch[0] : '';
  let pos = indent.length;

  let bullet: string | null = null;
  let isListItem = false;
  const bulletMatch = BULLET_RE.exec(raw.slice(pos));
  if (bulletMatch) {
    bullet = bulletMatch[1] ?? null;
    isListItem = true;
    pos += bulletMatch[0].length;
  }

  let status: string | null = null;
  let statusSpan: [number, number] | null = null;
  let isTask = false;
  if (isListItem) {
    const statusMatch = STATUS_RE.exec(raw.slice(pos));
    if (statusMatch) {
      isTask = true;
      status = statusMatch[1] ?? null;
      statusSpan = [pos + 1, pos + 2];
      pos += statusMatch[0].length;
    }
  }

  const contentStart = pos;

  const blockIdMatch = BLOCK_ID_RE.exec(raw);
  let blockId: string | null = null;
  let contentEnd = raw.length;
  if (blockIdMatch && blockIdMatch.index >= contentStart) {
    blockId = blockIdMatch[1] ?? null;
    contentEnd = blockIdMatch.index;
  }

  const content = raw.slice(contentStart, contentEnd);

  const fieldCandidates = findFieldCandidates(content);
  const priorityCandidates = findPriorityCandidates(content);
  const tagCandidates = findTagCandidates(content);
  const links = findLinks(content);

  const boundaryPositions = [
    ...fieldCandidates.map((f) => f.pos),
    ...priorityCandidates.map((p) => p.pos),
    ...tagCandidates.map((t) => t.pos),
  ].sort((a, b) => a - b);

  function nextBoundaryAfter(p: number): number {
    for (const b of boundaryPositions) {
      if (b > p) return b;
    }
    return content.length;
  }

  const fields: Partial<Record<FieldName, string>> = {};
  const fieldSpans: Partial<Record<FieldName, FieldSpan>> = {};
  const consumed: Array<[number, number]> = [];

  for (const cand of fieldCandidates) {
    if (fields[cand.name] !== undefined) continue;
    const afterEmoji = cand.pos + cand.len;
    if (content[afterEmoji] !== ' ') continue;
    const valueStart = afterEmoji + 1;
    const boundary = nextBoundaryAfter(cand.pos);
    const candidateText = content.slice(valueStart, boundary);

    let matchedValue: string | null;
    if (FREE_TEXT_FIELDS.has(cand.name)) {
      const trimmed = candidateText.trim();
      matchedValue = trimmed.length > 0 ? trimmed : null;
    } else {
      const pattern = DATETIME_FIELDS.has(cand.name)
        ? DATETIME_PREFIX_RE
        : cand.name === 'appointment'
          ? APPOINTMENT_PREFIX_RE
          : DATE_PREFIX_RE;
      const m = pattern.exec(candidateText);
      matchedValue = m ? m[0] : null;
    }

    if (matchedValue === null) continue;
    const valueEnd = valueStart + matchedValue.length;
    fields[cand.name] = matchedValue;
    fieldSpans[cand.name] = {
      tokenStart: contentStart + cand.pos,
      valueStart: contentStart + valueStart,
      valueEnd: contentStart + valueEnd,
    };
    consumed.push([cand.pos, valueEnd]);
  }

  let priority: string | null = null;
  let prioritySpan: [number, number] | null = null;
  for (const cand of priorityCandidates) {
    if (priority !== null) break;
    priority = cand.emoji;
    prioritySpan = [contentStart + cand.pos, contentStart + cand.pos + cand.len];
    consumed.push([cand.pos, cand.pos + cand.len]);
  }

  consumed.sort((a, b) => a[0] - b[0]);
  let description = '';
  let cursor = 0;
  for (const [s, e] of consumed) {
    if (s > cursor) description += content.slice(cursor, s);
    cursor = Math.max(cursor, e);
  }
  description += content.slice(cursor);
  description = description.trim();

  return {
    raw,
    indent,
    bullet,
    isListItem,
    isTask,
    status,
    statusSpan,
    contentStart,
    contentEnd,
    blockId,
    fields,
    fieldSpans,
    priority,
    prioritySpan,
    tags: tagCandidates.map((t) => t.value),
    links,
    description,
  };
}

export function parseLine(raw: string): ParsedLine {
  const a = analyzeLine(raw);
  return {
    raw,
    indent: a.indent,
    bullet: a.bullet,
    status: a.status,
    isListItem: a.isListItem,
    isTask: a.isTask,
    description: a.description,
    fields: a.fields,
    priority: a.priority,
    tags: a.tags,
    links: a.links,
    blockId: a.blockId,
  };
}

export function setField(raw: string, name: FieldName, value: string): string {
  const a = analyzeLine(raw);
  const existing = a.fieldSpans[name];
  if (existing) {
    return raw.slice(0, existing.valueStart) + value + raw.slice(existing.valueEnd);
  }

  const canonicalIdx = CANONICAL_ORDER.indexOf(name);
  let insertPos: number | null = null;
  for (const laterName of CANONICAL_ORDER.slice(canonicalIdx + 1)) {
    const span = a.fieldSpans[laterName];
    if (span) {
      insertPos = span.tokenStart;
      break;
    }
  }

  const token = `${FIELD_EMOJI[name]} ${value}`;
  if (insertPos !== null) {
    return raw.slice(0, insertPos) + token + ' ' + raw.slice(insertPos);
  }

  const endPos = a.contentEnd;
  const before = raw.slice(0, endPos);
  const needsLeadingSpace = !/\s$/.test(before);
  const insertion = (needsLeadingSpace ? ' ' : '') + token;
  return before + insertion + raw.slice(endPos);
}

export function removeField(raw: string, name: FieldName): string {
  const a = analyzeLine(raw);
  const span = a.fieldSpans[name];
  if (!span) return raw;

  let start = span.tokenStart;
  if (start > a.contentStart && /\s/.test(raw[start - 1] ?? '')) {
    start -= 1;
  }
  return raw.slice(0, start) + raw.slice(span.valueEnd);
}

export function setStatus(raw: string, status: string): string {
  const a = analyzeLine(raw);
  if (!a.isTask || !a.statusSpan) return raw;
  const [s, e] = a.statusSpan;
  return raw.slice(0, s) + status + raw.slice(e);
}

export function setBlockId(raw: string, id: string): string {
  const m = BLOCK_ID_RE.exec(raw);
  if (m && m.index !== undefined && m[1] !== undefined) {
    const idStart = m.index + 2; // past the leading whitespace + '^'
    const idEnd = idStart + m[1].length;
    return raw.slice(0, idStart) + id + raw.slice(idEnd);
  }
  return raw + ` ^${id}`;
}

export function setDescription(raw: string, description: string): string {
  const a = analyzeLine(raw);

  const fieldStarts = Object.values(a.fieldSpans)
    .filter((s): s is FieldSpan => s !== undefined)
    .map((s) => s.tokenStart);
  const boundaryCandidates = [...fieldStarts];
  if (a.prioritySpan) boundaryCandidates.push(a.prioritySpan[0]);
  const firstBoundary =
    boundaryCandidates.length > 0 ? Math.min(...boundaryCandidates) : a.contentEnd;

  const oldRegion = raw.slice(a.contentStart, firstBoundary);
  const trimmedOld = oldRegion.replace(/\s+$/, '');
  const trailingWhitespace = oldRegion.slice(trimmedOld.length);
  const nextCharIsWhitespace = firstBoundary < raw.length && /\s/.test(raw[firstBoundary] ?? '');

  let insertion = description;
  if (
    description.length > 0 &&
    trailingWhitespace.length === 0 &&
    !nextCharIsWhitespace &&
    firstBoundary < raw.length
  ) {
    insertion = description + ' ';
  }

  return raw.slice(0, a.contentStart) + insertion + trailingWhitespace + raw.slice(firstBoundary);
}

export function renderItemLine(opts: {
  task: boolean;
  status?: string;
  description: string;
  tags?: string[];
  fields?: Partial<Record<FieldName, string>>;
  blockId: string;
}): string {
  const parts: string[] = [];
  parts.push(opts.task ? `- [${opts.status ?? ' '}]` : '-');

  if (opts.description) parts.push(opts.description);
  if (opts.tags && opts.tags.length > 0) {
    parts.push(opts.tags.map((t) => `#${t}`).join(' '));
  }
  if (opts.fields) {
    for (const name of CANONICAL_ORDER) {
      const value = opts.fields[name];
      if (value !== undefined && value !== null && value !== '') {
        parts.push(`${FIELD_EMOJI[name]} ${value}`);
      }
    }
  }
  parts.push(`^${opts.blockId}`);

  return parts.join(' ');
}
