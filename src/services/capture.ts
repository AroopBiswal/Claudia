// capture (docs/tools.md "capture"): saves facts, tasks, follow-ups and
// appointments to the vault, one write per item, in order. Never throws for
// bad input: every problem comes back as a per-item result with `status`.

import { z } from 'zod';
import { newBlockId, type IdKind } from '../vault/ids.ts';
import { LAYOUT, personNotePath, sanitizeNoteName, topicNotePath } from '../vault/layout.ts';
import { renderItemLine, type FieldName } from '../vault/line.ts';
import { parseRepeat } from '../vault/repeat.ts';
import { matchRules, refusalReason, sensitiveGuard } from '../vault/rules.ts';
import { personNote, SEED_NOTES, topicNote } from '../vault/templates.ts';
import { parseDateExpression, parseTimeExpression } from '../time/expressions.ts';
import {
  formatReceipt,
  formatReceiptTime,
  instantToLocal,
  type LocalDateTime,
} from '../time/format.ts';
import {
  afterWrite,
  nowLabel,
  todayOf,
  zoneOf,
  type CalendarStatus,
  type ClaudiaContext,
} from './context.ts';
import { findSimilar } from './duplicates.ts';
import { appendLog } from './log.ts';

export const REPEAT_HELP =
  'Accepted phrases: "every day", "every N days", "every week", "every N weeks", ' +
  '"every week on Monday[, Thursday]", "every weekday", "every month", "every month on the 15th", ' +
  '"every year", optionally followed by " when done".';

export const captureItemSchema = z.object({
  kind: z
    .enum(['task', 'follow_up', 'appointment', 'fact'])
    .describe('What to save: task, follow_up, appointment, or fact.'),
  text: z
    .string()
    .min(1)
    .describe('The task/follow-up/fact text, or the appointment title. Required.'),
  remind_at: z
    .string()
    .optional()
    .describe('Time expression that makes this a timed reminder (task, follow_up).'),
  due: z.string().optional().describe('Date expression for when it is due (task, follow_up).'),
  repeat: z
    .string()
    .optional()
    .describe('Tasks-style repeat rule, e.g. "every week on Sunday" (task only).'),
  person: z
    .string()
    .optional()
    .describe("The person's name as the user says it (required for follow_up; optional for fact)."),
  direction: z
    .enum(['waiting', 'promised'])
    .optional()
    .describe(
      'Whether the owner is waiting on them or promised them something (follow_up, required).',
    ),
  topic: z
    .string()
    .optional()
    .describe('Area of life for a fact, e.g. Travel, Health, Work. Omit for core profile facts.'),
  expires: z.string().optional().describe('Date expression for when a fact expires.'),
  start: z
    .string()
    .optional()
    .describe('Time expression for when the appointment starts (required for appointment).'),
  end: z
    .string()
    .optional()
    .describe(
      'Time expression for when the appointment ends; same day, defaults to start + 60 min.',
    ),
  location: z.string().optional().describe('Appended to the appointment title as "at <location>".'),
  tags: z.array(z.string()).optional().describe('Tags without the # (task, follow_up).'),
});

export type CaptureItem = z.infer<typeof captureItemSchema>;

export const captureInputSchema = z.object({
  items: z.array(captureItemSchema).min(1).max(20).describe('Items to save, 1 to 20.'),
  surface: z
    .string()
    .optional()
    .describe(
      'Where the user said it (web chat, desktop chat, iPhone chat, voice, Cowork, Claude Code, brief, email).',
    ),
  source_words: z.string().optional().describe("The user's words, verbatim, short."),
});

export type CaptureInput = z.infer<typeof captureInputSchema>;

export type CaptureStatus = 'saved' | 'duplicate' | 'refused' | 'invalid';

export interface CaptureItemResult {
  index: number;
  status: CaptureStatus;
  kind: CaptureItem['kind'];
  id?: string;
  note?: string;
  line?: string;
  reminder?: { local: string; display: string };
  calendar?: CalendarStatus;
  similar?: Array<{ id: string; text: string; note: string }>;
  reason?: string;
}

export interface CaptureResult {
  now: string;
  results: CaptureItemResult[];
  receipt?: string;
}

// --- text sanitising --------------------------------------------------

// Field emojis a user could type in free text to fake a field. 🗓️ has a
// trailing variation selector (U+FE0F); its bare form 🗓 is listed too.
const FORBIDDEN_TEXT_EMOJIS = [
  '⏰',
  '💤',
  '🗓️',
  '🗓',
  '🔁',
  '📅',
  '✅',
  '➕',
  '⌛',
  '🚫',
  '❌',
  '⏳',
  '🛫',
];

function stripForbiddenEmojis(text: string): string {
  let result = text;
  for (const emoji of FORBIDDEN_TEXT_EMOJIS) {
    result = result.split(emoji).join('');
  }
  return result;
}

/** Strips newlines and `^` (fake block ids), forbidden field emoji, collapses whitespace. */
export function sanitizeText(raw: string): string {
  let t = raw.replace(/\r\n|\r|\n/g, ' ');
  t = t.replace(/\^/g, '');
  t = stripForbiddenEmojis(t);
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- per-kind field applicability --------------------------------------

const ALLOWED_FIELDS: Record<CaptureItem['kind'], Set<string>> = {
  task: new Set(['kind', 'text', 'remind_at', 'due', 'repeat', 'tags']),
  follow_up: new Set(['kind', 'text', 'remind_at', 'due', 'person', 'direction', 'tags']),
  appointment: new Set(['kind', 'text', 'start', 'end', 'location']),
  fact: new Set(['kind', 'text', 'person', 'topic', 'expires']),
};

function fieldsError(item: CaptureItem): string | null {
  const allowed = ALLOWED_FIELDS[item.kind];
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) {
      return `"${key}" does not apply to kind "${item.kind}".`;
    }
  }
  return null;
}

function seedContent(path: string): string {
  return SEED_NOTES.find((n) => n.path === path)?.content ?? '';
}

const KIND_LETTER: Record<CaptureItem['kind'], IdKind> = {
  task: 't',
  follow_up: 't',
  appointment: 'a',
  fact: 'f',
};

interface ProcessOutcome {
  result: CaptureItemResult;
  touched: Set<string>;
  saved?: { id: string; path: string };
  reminderLocal?: LocalDateTime;
}

function invalidOutcome(index: number, kind: CaptureItem['kind'], reason: string): ProcessOutcome {
  return { result: { index, status: 'invalid', kind, reason }, touched: new Set() };
}

function refusedOutcome(index: number, kind: CaptureItem['kind'], reason: string): ProcessOutcome {
  return { result: { index, status: 'refused', kind, reason }, touched: new Set() };
}

/** Case-insensitive whole-word first occurrence of `name` in `text`, replaced by a wiki link. */
function linkPersonInText(text: string, name: string, target: string): string | null {
  const regex = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
  const m = regex.exec(text);
  if (!m) return null;
  const occurrence = m[0];
  const link =
    occurrence.toLowerCase() === target.toLowerCase()
      ? `[[${target}]]`
      : `[[${target}|${occurrence}]]`;
  return text.slice(0, m.index) + link + text.slice(m.index + occurrence.length);
}

export async function capture(ctx: ClaudiaContext, input: CaptureInput): Promise<CaptureResult> {
  const zone = zoneOf(ctx);
  const today = todayOf(ctx);
  const now = ctx.clock.now();
  const usedIds = new Set<string>();

  function nextId(kind: CaptureItem['kind']): string {
    const letter = KIND_LETTER[kind];
    const id = newBlockId(
      letter,
      (candidate) => ctx.index.hasId(candidate) || usedIds.has(candidate),
    );
    usedIds.add(id);
    return id;
  }

  const results: CaptureItemResult[] = [];
  const touchedPaths = new Set<string>();
  const savedEntries: { id: string; path: string }[] = [];
  const reminderLocals: LocalDateTime[] = [];

  for (let index = 0; index < input.items.length; index++) {
    const item = input.items[index]!;
    const outcome = await processItem(item, index);
    results.push(outcome.result);
    for (const p of outcome.touched) touchedPaths.add(p);
    if (outcome.saved) savedEntries.push(outcome.saved);
    if (outcome.reminderLocal) reminderLocals.push(outcome.reminderLocal);
  }

  if (touchedPaths.size > 0) {
    await afterWrite(ctx, touchedPaths);
  }

  if (savedEntries.length > 0) {
    ctx.state.recordCapture({
      surface: input.surface ?? null,
      words: input.source_words ?? null,
      entries: savedEntries,
    });
  }

  const receipt = formatReceipt(reminderLocals, { now, zone }) ?? undefined;

  return { now: nowLabel(ctx), results, receipt };

  async function processItem(item: CaptureItem, index: number): Promise<ProcessOutcome> {
    const kind = item.kind;

    const fieldsProblem = fieldsError(item);
    if (fieldsProblem) return invalidOutcome(index, kind, fieldsProblem);

    const text = sanitizeText(item.text);
    if (text.length === 0) return invalidOutcome(index, kind, 'Text is required.');

    const person = item.person !== undefined ? sanitizeText(item.person) : undefined;
    const topic = item.topic !== undefined ? sanitizeText(item.topic) : undefined;
    const location = item.location !== undefined ? sanitizeText(item.location) : undefined;
    const tags = (item.tags ?? []).map((t) => sanitizeText(t)).filter((t) => t.length > 0);

    if (kind === 'follow_up') {
      if (!person || person.length === 0)
        return invalidOutcome(index, kind, 'A person is required.');
      if (!item.direction)
        return invalidOutcome(index, kind, 'A direction (waiting or promised) is required.');
    }
    if (kind === 'appointment' && (!item.start || item.start.trim().length === 0)) {
      return invalidOutcome(index, kind, 'A start time is required.');
    }

    // Guard: never-save rules and the sensitive-data guard.
    const guardTexts = [text, person, topic, location].filter(
      (t): t is string => t !== undefined && t.length > 0,
    );
    for (const t of guardTexts) {
      const hit = sensitiveGuard(t);
      if (hit) return refusedOutcome(index, kind, hit.reason);
    }
    const ruleMatch = matchRules(guardTexts, ctx.index.rules());
    if (ruleMatch) return refusedOutcome(index, kind, refusalReason(ruleMatch));

    // Kind-specific time resolution and line building.
    if (kind === 'task') {
      return buildTaskOrFollowUp(index, kind, item, text, tags, undefined, undefined);
    }
    if (kind === 'follow_up') {
      return buildTaskOrFollowUp(index, kind, item, text, tags, person, item.direction);
    }
    if (kind === 'appointment') {
      return buildAppointment(index, item, text, location);
    }
    return buildFact(index, item, text, person, topic);
  }

  function pastReminderError(local: LocalDateTime): string {
    return `That time has already passed: ${formatReceiptTime(local, { now, zone })}.`;
  }

  async function buildTaskOrFollowUp(
    index: number,
    kind: 'task' | 'follow_up',
    item: CaptureItem,
    text: string,
    tags: string[],
    person: string | undefined,
    direction: 'waiting' | 'promised' | undefined,
  ): Promise<ProcessOutcome> {
    let reminderLocal: LocalDateTime | undefined;
    if (item.remind_at !== undefined) {
      const parsed = parseTimeExpression(item.remind_at, { now, zone });
      if (!parsed.ok) return invalidOutcome(index, kind, parsed.error);
      if (parsed.value.instant.getTime() < now.getTime()) {
        return invalidOutcome(index, kind, pastReminderError(parsed.value.local));
      }
      reminderLocal = parsed.value.local;
    }

    let dueDate: string | undefined;
    if (item.due !== undefined) {
      const parsed = parseDateExpression(item.due, { now, zone });
      if (!parsed.ok) return invalidOutcome(index, kind, parsed.error);
      dueDate = parsed.value;
    }

    let repeatText: string | undefined;
    if (kind === 'task' && item.repeat !== undefined) {
      const rule = parseRepeat(item.repeat);
      if (!rule.valid) {
        return invalidOutcome(index, kind, `Could not understand that repeat rule. ${REPEAT_HELP}`);
      }
      repeatText = item.repeat.trim();
    }

    let description = text;
    const lineTags: string[] = [];
    let notePath: string;

    if (kind === 'follow_up') {
      const target = sanitizeNoteName(person ?? '');
      const linked = linkPersonInText(text, person ?? '', target);
      description =
        linked ??
        (direction === 'waiting'
          ? `Waiting on [[${target}]]: ${text}`
          : `${text} (for [[${target}]])`);
      lineTags.push(direction === 'waiting' ? 'waiting' : 'promised', ...tags);
      notePath = LAYOUT.followUps;
    } else {
      lineTags.push(...tags);
      notePath = LAYOUT.todo;
    }

    const fields: Partial<Record<FieldName, string>> = {};
    if (reminderLocal) fields.reminder = reminderLocal;
    if (kind === 'follow_up') fields.created = today;
    if (repeatText) fields.repeat = repeatText;
    if (dueDate) fields.due = dueDate;

    const similar = findSimilar(ctx, kind, description);
    const top = similar[0];
    if (top && top.score >= 0.8) {
      return {
        result: {
          index,
          status: 'duplicate',
          kind,
          reason: 'An open item like this already exists.',
          similar: [{ id: top.item.id ?? '', text: top.item.text, note: top.item.path }],
        },
        touched: new Set(),
      };
    }

    const id = nextId(kind);
    const line = renderItemLine({ task: true, description, tags: lineTags, fields, blockId: id });

    const touched = new Set<string>();
    if (kind === 'follow_up') {
      const personPath = personNotePath(sanitizeNoteName(person ?? ''));
      await ctx.writer.editText(personPath, (t) => t, {
        createWith: personNote(sanitizeNoteName(person ?? '')),
      });
      touched.add(personPath);
    }

    await ctx.writer.append(notePath, [line], { createWith: seedContent(notePath) });
    touched.add(notePath);

    let details = '';
    if (reminderLocal) details += ` ⏰ ${formatReceiptTime(reminderLocal, { now, zone })}`;
    if (dueDate) details += ` 📅 ${dueDate}`;
    await appendLog(ctx, {
      surface: input.surface ?? null,
      verb: 'added',
      path: notePath,
      id,
      text: description,
      details: details.length > 0 ? details : undefined,
      words: input.source_words ?? null,
    });

    const result: CaptureItemResult = {
      index,
      status: 'saved',
      kind,
      id,
      note: notePath,
      line,
    };
    if (top) {
      result.similar = similar.map((s) => ({
        id: s.item.id ?? '',
        text: s.item.text,
        note: s.item.path,
      }));
    }
    if (reminderLocal) {
      result.reminder = {
        local: reminderLocal,
        display: formatReceiptTime(reminderLocal, { now, zone }),
      };
    }

    return {
      result,
      touched,
      saved: { id, path: notePath },
      reminderLocal,
    };
  }

  async function buildAppointment(
    index: number,
    item: CaptureItem,
    text: string,
    location: string | undefined,
  ): Promise<ProcessOutcome> {
    const startParsed = parseTimeExpression(item.start ?? '', { now, zone });
    if (!startParsed.ok) return invalidOutcome(index, 'appointment', startParsed.error);
    const date = startParsed.value.local.slice(0, 10);
    const startTime = startParsed.value.local.slice(11);

    let endTime: string;
    if (item.end !== undefined) {
      const endParsed = parseTimeExpression(item.end, { now, zone });
      if (!endParsed.ok) return invalidOutcome(index, 'appointment', endParsed.error);
      const endDate = endParsed.value.local.slice(0, 10);
      if (endDate !== date) {
        return invalidOutcome(
          index,
          'appointment',
          'The end time must be on the same day as the start.',
        );
      }
      endTime = endParsed.value.local.slice(11);
      if (endTime <= startTime) {
        return invalidOutcome(index, 'appointment', 'The end time must be after the start.');
      }
    } else {
      const endInstant = new Date(startParsed.value.instant.getTime() + 60 * 60_000);
      endTime = instantToLocal(endInstant, zone).slice(11);
    }

    const description = location ? `${text} at ${location}` : text;

    const similar = findSimilar(ctx, 'appointment', description);
    const top = similar[0];
    if (top && top.score >= 0.8) {
      return {
        result: {
          index,
          status: 'duplicate',
          kind: 'appointment',
          reason: 'An open appointment like this already exists.',
          similar: [{ id: top.item.id ?? '', text: top.item.text, note: top.item.path }],
        },
        touched: new Set(),
      };
    }

    const id = nextId('appointment');
    const fields: Partial<Record<FieldName, string>> = {
      appointment: `${date} ${startTime}-${endTime}`,
    };
    const line = renderItemLine({
      task: true,
      description,
      tags: ['appointment'],
      fields,
      blockId: id,
    });

    await ctx.writer.append(LAYOUT.appointments, [line], {
      createWith: seedContent(LAYOUT.appointments),
    });
    const touched = new Set<string>([LAYOUT.appointments]);

    let calendar: CalendarStatus;
    if (!ctx.calendar) {
      calendar = 'not_configured';
    } else {
      try {
        calendar = await ctx.calendar.upsert(id);
      } catch (err) {
        calendar = 'pending';
        ctx.log(
          `capture: calendar upsert failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await appendLog(ctx, {
      surface: input.surface ?? null,
      verb: 'added',
      path: LAYOUT.appointments,
      id,
      text: description,
      details: ` 🗓️ ${formatReceiptTime(`${date} ${startTime}`, { now, zone })}`,
      words: input.source_words ?? null,
    });

    const result: CaptureItemResult = {
      index,
      status: 'saved',
      kind: 'appointment',
      id,
      note: LAYOUT.appointments,
      line,
      calendar,
    };
    if (top) {
      result.similar = similar.map((s) => ({
        id: s.item.id ?? '',
        text: s.item.text,
        note: s.item.path,
      }));
    }

    return { result, touched, saved: { id, path: LAYOUT.appointments } };
  }

  async function buildFact(
    index: number,
    item: CaptureItem,
    text: string,
    person: string | undefined,
    topic: string | undefined,
  ): Promise<ProcessOutcome> {
    let expires: string | undefined;
    if (item.expires !== undefined) {
      const parsed = parseDateExpression(item.expires, { now, zone });
      if (!parsed.ok) return invalidOutcome(index, 'fact', parsed.error);
      expires = parsed.value;
    }

    let notePath: string;
    let createWith: string;
    if (person && person.length > 0) {
      const name = sanitizeNoteName(person);
      notePath = personNotePath(name);
      createWith = personNote(name);
    } else if (topic && topic.length > 0) {
      const name = sanitizeNoteName(topic);
      notePath = topicNotePath(name);
      createWith = topicNote(name);
    } else {
      notePath = LAYOUT.profile;
      createWith = seedContent(LAYOUT.profile);
    }

    const similar = findSimilar(ctx, 'fact', text);
    const top = similar[0];
    if (top && top.score >= 0.8) {
      return {
        result: {
          index,
          status: 'duplicate',
          kind: 'fact',
          reason: 'A fact like this is already saved.',
          similar: [{ id: top.item.id ?? '', text: top.item.text, note: top.item.path }],
        },
        touched: new Set(),
      };
    }

    const id = nextId('fact');
    const fields: Partial<Record<FieldName, string>> = {};
    if (expires) fields.expires = expires;
    fields.created = instantToLocal(now, zone);
    const line = renderItemLine({ task: false, description: text, fields, blockId: id });

    await ctx.writer.append(notePath, [line], { createWith });

    await appendLog(ctx, {
      surface: input.surface ?? null,
      verb: 'added',
      path: notePath,
      id,
      text,
      words: input.source_words ?? null,
    });

    const result: CaptureItemResult = {
      index,
      status: 'saved',
      kind: 'fact',
      id,
      note: notePath,
      line,
    };
    if (top) {
      result.similar = similar.map((s) => ({
        id: s.item.id ?? '',
        text: s.item.text,
        note: s.item.path,
      }));
    }

    return { result, touched: new Set([notePath]), saved: { id, path: notePath } };
  }
}
