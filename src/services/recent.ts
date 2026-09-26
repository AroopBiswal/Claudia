// Recently captured (vault-format.md section 5 "Log/YYYY-MM-DD.md" and
// "Recently captured.md"): parses the `added` lines Claudia's Log notes
// carry, tolerant of malformed lines, for the generated "Recently captured"
// note and the agenda "recent" views.

import { isInCodeFence, parseNote } from '../vault/note.ts';
import { logNotePath } from '../vault/layout.ts';
import { addDays } from '../time/format.ts';
import { todayOf, type ClaudiaContext } from './context.ts';

export interface RecentCapture {
  /** 'YYYY-MM-DD' local, the Log note's date. */
  date: string;
  /** 'HH:mm' local. */
  time: string;
  surface: string;
  id: string;
  text: string;
  /** Basename of the note the item was written to, e.g. "To do". */
  note: string;
  /** Anything between the link and the quoted words, e.g. "⏰ Tue 9:00am". */
  details: string | null;
  /** The user's source words, if the capture carried them. */
  words: string | null;
}

// `- HH:mm · <surface> · added [[<Note>#^<id>|<text>]]<details>[ · "<words>"]`
const ADDED_LINE_RE =
  /^-\s(\d{2}:\d{2})\s·\s([^·]+?)\s·\sadded\s\[\[([^\]#]+)#\^([A-Za-z0-9-]+)\|([^\]]+)\]\](.*)$/;

const QUOTED_WORDS_RE = /\s·\s"([\s\S]*)"$/;

function parseAddedLine(date: string, raw: string): RecentCapture | null {
  const m = ADDED_LINE_RE.exec(raw);
  if (!m) return null;

  const [, time, surfaceRaw, note, id, text, restRaw] = m;
  if (
    time === undefined ||
    surfaceRaw === undefined ||
    note === undefined ||
    id === undefined ||
    text === undefined ||
    restRaw === undefined
  ) {
    return null;
  }

  const surface = surfaceRaw.trim();
  if (surface.length === 0) return null;

  let details: string | null;
  let words: string | null = null;

  const quoted = QUOTED_WORDS_RE.exec(restRaw);
  if (quoted && quoted[1] !== undefined) {
    words = quoted[1];
    const before = restRaw.slice(0, quoted.index).trim();
    details = before.length > 0 ? before : null;
  } else {
    const trimmed = restRaw.trim();
    details = trimmed.length > 0 ? trimmed : null;
  }

  return { date, time, surface, id, text, note, details, words };
}

/** `added` entries from the last `days` Log notes (today back through today-(days-1)), newest first. */
export async function recentCaptures(ctx: ClaudiaContext, days: number): Promise<RecentCapture[]> {
  const today = todayOf(ctx);
  const n = Math.max(1, Math.trunc(days));

  const results: RecentCapture[] = [];
  for (let i = 0; i < n; i++) {
    const date = addDays(today, -i);
    const text = await ctx.writer.read(logNotePath(date));
    if (text === null) continue;

    const note = parseNote(text);
    const fenceFlags = isInCodeFence(note);
    const fmEnd = note.frontmatter ? note.frontmatter.endLine : -1;

    note.lines.forEach((line, idx) => {
      if (idx <= fmEnd || fenceFlags[idx]) return;
      const parsed = parseAddedLine(date, line.text);
      if (parsed) results.push(parsed);
    });
  }

  return results.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
}
