// The vault Log (vault-format.md "Log/YYYY-MM-DD.md"): one append-only note
// per day, one line per change Claudia makes. Every service that writes to
// the vault appends one of these lines after its own write.

import { logNotePath } from '../vault/layout.ts';
import { wikiLink } from '../vault/layout.ts';
import { logNote } from '../vault/templates.ts';
import { nowLocalOf, todayOf, type ClaudiaContext } from './context.ts';

export interface LogEntry {
  /** Where the change came from, e.g. "iPhone chat", "push", "janitor". null renders as "Claudia". */
  surface: string | null;
  /** added | completed | reopened | snoozed | rescheduled | edited | forgot | undid | added rule | removed rule | changed setting | merged conflict copy | archived | nudged */
  verb: string;
  /** Note the item lives in, for the link. Omit for entries with no single item (e.g. undo of several). */
  path?: string;
  /** Block ID for the link anchor. */
  id?: string | null;
  /** Link label (the item's text). */
  text?: string;
  /** Extra detail, e.g. " ⏰ Tue 9:00am". Must start with its own leading space. */
  details?: string;
  /** The user's source words, quoted verbatim (sanitized here). */
  words?: string | null;
}

const MAX_WORDS_LENGTH = 200;

function sanitizeWords(words: string): string {
  const collapsed = words
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const quoted = collapsed.replace(/"/g, "'");
  if (quoted.length <= MAX_WORDS_LENGTH) return quoted;
  return `${quoted.slice(0, MAX_WORDS_LENGTH - 1)}…`;
}

/** Formats one Log line (vault-format.md "Log"). `hhmm` is local time, 'HH:mm'. */
export function formatLogLine(e: LogEntry, hhmm: string): string {
  const surface = (e.surface ?? 'Claudia').split(' · ').join(' - ');
  let line = `- ${hhmm} · ${surface} · ${e.verb}`;

  if (e.path) {
    line += ` ${wikiLink(e.path, e.id ?? undefined, e.text)}`;
  }
  if (e.details) {
    line += e.details;
  }
  if (e.words) {
    const words = sanitizeWords(e.words);
    if (words.length > 0) {
      line += ` · "${words}"`;
    }
  }
  return line;
}

/** Appends one Log line to today's Log note, creating it if needed. */
export async function appendLog(ctx: ClaudiaContext, e: LogEntry): Promise<void> {
  const today = todayOf(ctx);
  const path = logNotePath(today);
  const hhmm = nowLocalOf(ctx).slice(11);
  const line = formatLogLine(e, hhmm);
  await ctx.writer.append(path, [line], { createWith: logNote(today) });
}
