// update (docs/tools.md "update"): completes, reopens, snoozes, reschedules,
// edits and forgets items; undoes the last capture; manages rules and
// settings; and backs the push-link actions (done / +1h / tomorrow).

import { z } from 'zod';
import type { IndexedItem } from '../engine/index.ts';
import { newBlockId } from '../vault/ids.ts';
import { LAYOUT } from '../vault/layout.ts';
import {
  parseLine,
  removeField,
  renderItemLine,
  setBlockId,
  setDescription,
  setField,
  setStatus,
  type FieldName,
} from '../vault/line.ts';
import { nextRepeatFields, parseRepeat } from '../vault/repeat.ts';
import { normalizeKeywords } from '../vault/rules.ts';
import { setSettingInText, validateSetting } from '../vault/settings.ts';
import { SEED_NOTES } from '../vault/templates.ts';
import { parseDateExpression, parseTimeExpression } from '../time/expressions.ts';
import { addDays, formatReceiptTime, instantToLocal, localToInstant } from '../time/format.ts';
import { afterWrite, nowLabel, todayOf, zoneOf, type ClaudiaContext } from './context.ts';
import { REPEAT_HELP, sanitizeText } from './capture.ts';
import { appendLog } from './log.ts';
import { itemView, type ItemView } from './views.ts';

export const updateInputSchema = z.object({
  action: z
    .enum([
      'complete',
      'reopen',
      'snooze',
      'reschedule',
      'edit',
      'forget',
      'undo',
      'add_rule',
      'remove_rule',
      'set_setting',
    ])
    .describe('The change to make.'),
  id: z
    .string()
    .optional()
    .describe(
      'The item or rule block ID (with or without ^). Required except for undo, add_rule, set_setting.',
    ),
  until: z.string().optional().describe('Time expression to snooze until.'),
  remind_at: z
    .string()
    .optional()
    .describe('Time expression to reschedule a task/follow-up reminder; "" removes it.'),
  due: z.string().optional().describe('Date expression to reschedule; "" removes it.'),
  start: z.string().optional().describe('Time expression to reschedule an appointment start.'),
  end: z.string().optional().describe('Time expression to reschedule an appointment end.'),
  repeat: z.string().optional().describe('Repeat rule for edit; "" removes it.'),
  text: z
    .string()
    .optional()
    .describe(
      "edit: the new description (tags/links kept). add_rule: the rule in the user's words.",
    ),
  keywords: z
    .array(z.string())
    .min(1)
    .max(20)
    .optional()
    .describe('add_rule: 1 to 20 keywords or short phrases.'),
  setting: z.string().optional().describe('set_setting: the setting name.'),
  value: z.string().optional().describe('set_setting: the new value.'),
  surface: z.string().optional().describe('Where the request came from.'),
  source_words: z.string().optional().describe("The user's words, verbatim, short."),
});

export type UpdateInput = z.infer<typeof updateInputSchema>;

export interface UpdateResult {
  now: string;
  status: 'ok' | 'not_found' | 'invalid';
  id?: string;
  message: string;
  item?: ItemView;
}

function stripCaret(id: string): string {
  return id.startsWith('^') ? id.slice(1) : id;
}

function invalidResult(now: string, message: string, id?: string): UpdateResult {
  return { now, status: 'invalid', id, message };
}

function notFoundResult(now: string, id: string): UpdateResult {
  return { now, status: 'not_found', id, message: `No item with id "${id}".` };
}

// vault-format.md 4.3: tags and links stay in the description, so item.text
// for a follow-up carries "#waiting"/"#promised" and an appointment carries
// "#appointment". Strip them for a Log link label, which should read cleanly.
const TAG_RE = /(?<![\p{L}\p{N}_])#[\p{L}\p{N}_/-]+/gu;

function logLabel(text: string): string {
  return text.replace(TAG_RE, '').replace(/\s+/g, ' ').trim();
}

function seedContent(path: string): string {
  return SEED_NOTES.find((n) => n.path === path)?.content ?? '';
}

function view(ctx: ClaudiaContext, id: string): ItemView | undefined {
  const fresh = ctx.index.getItem(id);
  return fresh ? itemView(fresh, { vaultName: ctx.vaultName, today: todayOf(ctx) }) : undefined;
}

/**
 * Edits a line by block id, retrying once against a freshly reindexed file
 * when the index was stale (the item moved, e.g. after an external edit).
 */
async function editItemLine(
  ctx: ClaudiaContext,
  item: IndexedItem,
  editFn: (raw: string) => string | null,
): Promise<{ found: boolean; path: string }> {
  let path = item.path;
  let result = await ctx.writer.editById(path, item.id!, editFn);
  if (!result.found) {
    await ctx.index.reindexFile(path);
    const fresh = ctx.index.getItem(item.id!);
    if (!fresh) return { found: false, path };
    path = fresh.path;
    result = await ctx.writer.editById(path, item.id!, editFn);
  }
  return { found: result.found, path };
}

async function doComplete(
  ctx: ClaudiaContext,
  id: string,
  item: IndexedItem,
  input: UpdateInput,
  now: string,
): Promise<UpdateResult> {
  const today = todayOf(ctx);
  const originalRaw = item.raw;

  const editFn = (raw: string): string => {
    let updated = setStatus(raw, 'x');
    updated = setField(updated, 'done', today);
    updated = removeField(updated, 'snooze');
    return updated;
  };

  const editResult = await editItemLine(ctx, item, editFn);
  if (!editResult.found) return notFoundResult(now, id);

  if (item.kind === 'task' || item.kind === 'follow_up') {
    const parsedOriginal = parseLine(originalRaw);
    const repeatText = parsedOriginal.fields.repeat;
    if (repeatText) {
      const rule = parseRepeat(repeatText);
      if (rule.valid) {
        const shifted = nextRepeatFields(
          {
            reminder: parsedOriginal.fields.reminder ?? null,
            due: parsedOriginal.fields.due ?? null,
            scheduled: parsedOriginal.fields.scheduled ?? null,
            start: parsedOriginal.fields.start ?? null,
          },
          rule,
          today,
        );
        if (shifted) {
          let nextLine = setStatus(originalRaw, ' ');
          nextLine = removeField(nextLine, 'done');
          nextLine = removeField(nextLine, 'snooze');
          nextLine = removeField(nextLine, 'created');
          if (shifted.reminder) nextLine = setField(nextLine, 'reminder', shifted.reminder);
          if (shifted.due) nextLine = setField(nextLine, 'due', shifted.due);
          if (shifted.scheduled) nextLine = setField(nextLine, 'scheduled', shifted.scheduled);
          if (shifted.start) nextLine = setField(nextLine, 'start', shifted.start);
          const newId = newBlockId('t', (candidate) => ctx.index.hasId(candidate));
          nextLine = setBlockId(nextLine, newId);
          await ctx.writer.insertAboveId(editResult.path, id, [nextLine]);
        }
      }
    }
  }

  await appendLog(ctx, {
    surface: input.surface ?? null,
    verb: 'completed',
    path: editResult.path,
    id,
    text: logLabel(item.text),
    words: input.source_words ?? null,
  });
  await afterWrite(ctx, [editResult.path]);

  return { now, status: 'ok', id, message: 'Completed.', item: view(ctx, id) };
}

async function doReopen(
  ctx: ClaudiaContext,
  id: string,
  item: IndexedItem,
  input: UpdateInput,
  now: string,
): Promise<UpdateResult> {
  const editFn = (raw: string): string => removeField(setStatus(raw, ' '), 'done');
  const editResult = await editItemLine(ctx, item, editFn);
  if (!editResult.found) return notFoundResult(now, id);

  await appendLog(ctx, {
    surface: input.surface ?? null,
    verb: 'reopened',
    path: editResult.path,
    id,
    text: logLabel(item.text),
    words: input.source_words ?? null,
  });
  await afterWrite(ctx, [editResult.path]);

  return { now, status: 'ok', id, message: 'Reopened.', item: view(ctx, id) };
}

async function doSnooze(
  ctx: ClaudiaContext,
  id: string,
  item: IndexedItem,
  input: UpdateInput,
  now: string,
): Promise<UpdateResult> {
  if (input.until === undefined)
    return invalidResult(now, 'A time to snooze until is required.', id);

  const zone = zoneOf(ctx);
  const parsed = parseTimeExpression(input.until, { now: ctx.clock.now(), zone });
  if (!parsed.ok) return invalidResult(now, parsed.error, id);
  if (item.reminder && parsed.value.local <= item.reminder) {
    return invalidResult(
      now,
      'The snooze time must be after the current reminder; use reschedule instead.',
      id,
    );
  }

  const editFn = (raw: string): string => setField(raw, 'snooze', parsed.value.local);
  const editResult = await editItemLine(ctx, item, editFn);
  if (!editResult.found) return notFoundResult(now, id);

  const display = formatReceiptTime(parsed.value.local, { now: ctx.clock.now(), zone });
  await appendLog(ctx, {
    surface: input.surface ?? null,
    verb: 'snoozed',
    path: editResult.path,
    id,
    text: logLabel(item.text),
    details: ` 💤 ${display}`,
    words: input.source_words ?? null,
  });
  await afterWrite(ctx, [editResult.path]);

  return { now, status: 'ok', id, message: `Snoozed until ${display}.`, item: view(ctx, id) };
}

async function doRescheduleAppointment(
  ctx: ClaudiaContext,
  id: string,
  item: IndexedItem,
  input: UpdateInput,
  now: string,
): Promise<UpdateResult> {
  if (input.start === undefined && input.end === undefined) {
    return invalidResult(now, 'Nothing to reschedule.', id);
  }

  const zone = zoneOf(ctx);
  const nowDate = ctx.clock.now();
  let date = item.appointment?.date ?? todayOf(ctx);
  let startTime = item.appointment?.start ?? '09:00';

  if (input.start !== undefined) {
    const parsed = parseTimeExpression(input.start, { now: nowDate, zone });
    if (!parsed.ok) return invalidResult(now, parsed.error, id);
    date = parsed.value.local.slice(0, 10);
    startTime = parsed.value.local.slice(11);
  }

  let endTime: string;
  if (input.end !== undefined) {
    const parsedEnd = parseTimeExpression(input.end, { now: nowDate, zone });
    if (!parsedEnd.ok) return invalidResult(now, parsedEnd.error, id);
    const endDate = parsedEnd.value.local.slice(0, 10);
    if (endDate !== date) {
      return invalidResult(now, 'The end time must be on the same day as the start.', id);
    }
    endTime = parsedEnd.value.local.slice(11);
    if (endTime <= startTime) {
      return invalidResult(now, 'The end time must be after the start.', id);
    }
  } else {
    const startInstant = localToInstant(`${date} ${startTime}`, zone);
    endTime = instantToLocal(new Date(startInstant.getTime() + 60 * 60_000), zone).slice(11);
  }

  const value = `${date} ${startTime}-${endTime}`;
  const editFn = (raw: string): string =>
    removeField(setField(raw, 'appointment', value), 'snooze');
  const editResult = await editItemLine(ctx, item, editFn);
  if (!editResult.found) return notFoundResult(now, id);

  if (ctx.calendar) {
    try {
      await ctx.calendar.upsert(id);
    } catch (err) {
      ctx.log(
        `update: calendar upsert failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const display = formatReceiptTime(`${date} ${startTime}`, { now: nowDate, zone });
  await appendLog(ctx, {
    surface: input.surface ?? null,
    verb: 'rescheduled',
    path: editResult.path,
    id,
    text: logLabel(item.text),
    details: ` 🗓️ ${display}`,
    words: input.source_words ?? null,
  });
  await afterWrite(ctx, [editResult.path]);

  return { now, status: 'ok', id, message: `Rescheduled to ${display}.`, item: view(ctx, id) };
}

async function doRescheduleTaskOrFollowUp(
  ctx: ClaudiaContext,
  id: string,
  item: IndexedItem,
  input: UpdateInput,
  now: string,
): Promise<UpdateResult> {
  if (input.remind_at === undefined && input.due === undefined) {
    return invalidResult(now, 'Nothing to reschedule.', id);
  }

  const zone = zoneOf(ctx);
  const nowDate = ctx.clock.now();

  let remindValue: string | undefined;
  if (input.remind_at !== undefined && input.remind_at !== '') {
    const parsed = parseTimeExpression(input.remind_at, { now: nowDate, zone });
    if (!parsed.ok) return invalidResult(now, parsed.error, id);
    if (parsed.value.instant.getTime() < nowDate.getTime()) {
      return invalidResult(
        now,
        `That time has already passed: ${formatReceiptTime(parsed.value.local, { now: nowDate, zone })}.`,
        id,
      );
    }
    remindValue = parsed.value.local;
  }

  let dueValue: string | undefined;
  if (input.due !== undefined && input.due !== '') {
    const parsed = parseDateExpression(input.due, { now: nowDate, zone });
    if (!parsed.ok) return invalidResult(now, parsed.error, id);
    dueValue = parsed.value;
  }

  const editFn = (raw: string): string => {
    let updated = removeField(raw, 'snooze');
    if (input.remind_at !== undefined) {
      updated =
        input.remind_at === ''
          ? removeField(updated, 'reminder')
          : setField(updated, 'reminder', remindValue!);
    }
    if (input.due !== undefined) {
      updated =
        input.due === '' ? removeField(updated, 'due') : setField(updated, 'due', dueValue!);
    }
    return updated;
  };

  const editResult = await editItemLine(ctx, item, editFn);
  if (!editResult.found) return notFoundResult(now, id);

  let details = '';
  if (remindValue) details += ` ⏰ ${formatReceiptTime(remindValue, { now: nowDate, zone })}`;
  if (dueValue) details += ` 📅 ${dueValue}`;
  await appendLog(ctx, {
    surface: input.surface ?? null,
    verb: 'rescheduled',
    path: editResult.path,
    id,
    text: logLabel(item.text),
    details: details.length > 0 ? details : undefined,
    words: input.source_words ?? null,
  });
  await afterWrite(ctx, [editResult.path]);

  const message = remindValue
    ? `Rescheduled to ${formatReceiptTime(remindValue, { now: nowDate, zone })}.`
    : 'Rescheduled.';
  return { now, status: 'ok', id, message, item: view(ctx, id) };
}

async function doReschedule(
  ctx: ClaudiaContext,
  id: string,
  item: IndexedItem,
  input: UpdateInput,
  now: string,
): Promise<UpdateResult> {
  if (item.kind === 'appointment') {
    return doRescheduleAppointment(ctx, id, item, input, now);
  }
  return doRescheduleTaskOrFollowUp(ctx, id, item, input, now);
}

async function doEdit(
  ctx: ClaudiaContext,
  id: string,
  item: IndexedItem,
  input: UpdateInput,
  now: string,
): Promise<UpdateResult> {
  if (input.text === undefined && input.repeat === undefined) {
    return invalidResult(now, 'Nothing to edit.', id);
  }

  let repeatValue: string | undefined;
  if (input.repeat !== undefined && input.repeat !== '') {
    const rule = parseRepeat(input.repeat);
    if (!rule.valid) {
      return invalidResult(now, `Could not understand that repeat rule. ${REPEAT_HELP}`, id);
    }
    repeatValue = input.repeat.trim();
  }

  const newText = input.text !== undefined ? sanitizeText(input.text) : undefined;
  if (newText !== undefined && newText.length === 0)
    return invalidResult(now, 'Text is required.', id);

  const editFn = (raw: string): string => {
    let updated = raw;
    if (newText !== undefined) updated = setDescription(updated, newText);
    if (input.repeat !== undefined) {
      updated =
        input.repeat === ''
          ? removeField(updated, 'repeat')
          : setField(updated, 'repeat', repeatValue!);
    }
    return updated;
  };

  const editResult = await editItemLine(ctx, item, editFn);
  if (!editResult.found) return notFoundResult(now, id);

  await appendLog(ctx, {
    surface: input.surface ?? null,
    verb: 'edited',
    path: editResult.path,
    id,
    text: newText ?? logLabel(item.text),
    words: input.source_words ?? null,
  });
  await afterWrite(ctx, [editResult.path]);

  return { now, status: 'ok', id, message: 'Updated.', item: view(ctx, id) };
}

async function doForget(
  ctx: ClaudiaContext,
  id: string,
  item: IndexedItem,
  input: UpdateInput,
  now: string,
): Promise<UpdateResult> {
  const editResult = await editItemLine(ctx, item, () => null);
  if (!editResult.found) return notFoundResult(now, id);

  if (item.kind === 'appointment') {
    await ctx.calendar?.cancel(id);
  }

  await appendLog(ctx, {
    surface: input.surface ?? null,
    verb: 'forgot',
    path: editResult.path,
    id,
    text: logLabel(item.text),
    words: input.source_words ?? null,
  });
  await afterWrite(ctx, [editResult.path]);

  return { now, status: 'ok', id, message: 'Forgotten.' };
}

async function doUndo(ctx: ClaudiaContext, input: UpdateInput, now: string): Promise<UpdateResult> {
  const last = ctx.state.lastCapture();
  if (!last) {
    return { now, status: 'ok', message: 'Nothing to undo.' };
  }

  const removed: { id: string; path: string }[] = [];
  const touched = new Set<string>();
  for (const entry of last.entries) {
    const result = await ctx.writer.editById(entry.path, entry.id, () => null);
    if (result.found) {
      removed.push(entry);
      touched.add(entry.path);
      if (entry.id.startsWith('a')) {
        await ctx.calendar?.cancel(entry.id);
      }
    }
  }

  ctx.state.markCaptureUndone(last.captureId);

  const message =
    removed.length > 0
      ? `Undid the last capture: removed ${removed.map((r) => r.id).join(', ')}.`
      : 'Nothing to undo.';

  await appendLog(ctx, {
    surface: input.surface ?? null,
    verb: 'undid',
    details:
      removed.length > 0
        ? ` (${removed.length} item${removed.length === 1 ? '' : 's'})`
        : undefined,
    words: input.source_words ?? null,
  });
  if (touched.size > 0) await afterWrite(ctx, touched);

  return { now, status: 'ok', message };
}

async function doAddRule(
  ctx: ClaudiaContext,
  input: UpdateInput,
  now: string,
): Promise<UpdateResult> {
  if (!input.text || input.text.trim().length === 0) {
    return invalidResult(now, 'Rule text is required.');
  }
  const keywords = normalizeKeywords(input.keywords ?? []);
  if (keywords.length === 0) {
    return invalidResult(now, 'At least one keyword is required.');
  }

  const ruleText = sanitizeText(input.text);
  const id = newBlockId('r', (candidate) => ctx.index.hasId(candidate));
  const fields: Partial<Record<FieldName, string>> = { keywords: keywords.join(', ') };
  const line = renderItemLine({ task: false, description: ruleText, fields, blockId: id });

  await ctx.writer.append(LAYOUT.rules, [line], { createWith: seedContent(LAYOUT.rules) });
  await appendLog(ctx, {
    surface: input.surface ?? null,
    verb: 'added rule',
    path: LAYOUT.rules,
    id,
    text: ruleText,
    words: input.source_words ?? null,
  });
  await afterWrite(ctx, [LAYOUT.rules]);

  return { now, status: 'ok', id, message: `Added rule: "${ruleText}".`, item: view(ctx, id) };
}

async function doRemoveRule(
  ctx: ClaudiaContext,
  id: string,
  input: UpdateInput,
  now: string,
): Promise<UpdateResult> {
  const item = ctx.index.getItem(id);
  if (!item || item.kind !== 'rule') return notFoundResult(now, id);

  const editResult = await editItemLine(ctx, item, () => null);
  if (!editResult.found) return notFoundResult(now, id);

  await appendLog(ctx, {
    surface: input.surface ?? null,
    verb: 'removed rule',
    path: LAYOUT.rules,
    id,
    text: logLabel(item.text),
    words: input.source_words ?? null,
  });
  await afterWrite(ctx, [LAYOUT.rules]);

  return { now, status: 'ok', id, message: `Removed rule: "${item.text}".` };
}

async function doSetSetting(
  ctx: ClaudiaContext,
  input: UpdateInput,
  now: string,
): Promise<UpdateResult> {
  if (!input.setting || input.value === undefined) {
    return invalidResult(now, 'A setting name and value are required.');
  }
  const result = validateSetting(input.setting, input.value);
  if (!result.ok) return invalidResult(now, result.error);

  await ctx.writer.editText(LAYOUT.settings, (t) => setSettingInText(t, result.key, result.value), {
    createWith: seedContent(LAYOUT.settings),
  });
  await appendLog(ctx, {
    surface: input.surface ?? null,
    verb: 'changed setting',
    details: ` ${result.key}: ${result.value}`,
    words: input.source_words ?? null,
  });
  await afterWrite(ctx, [LAYOUT.settings]);

  return { now, status: 'ok', message: `Set "${result.key}" to "${result.value}".` };
}

export async function update(ctx: ClaudiaContext, input: UpdateInput): Promise<UpdateResult> {
  const now = nowLabel(ctx);

  if (input.action === 'undo') return doUndo(ctx, input, now);
  if (input.action === 'add_rule') return doAddRule(ctx, input, now);
  if (input.action === 'set_setting') return doSetSetting(ctx, input, now);

  if (!input.id) return invalidResult(now, 'An id is required.');
  const id = stripCaret(input.id);

  if (input.action === 'remove_rule') return doRemoveRule(ctx, id, input, now);

  const item = ctx.index.getItem(id);
  if (!item) return notFoundResult(now, id);

  switch (input.action) {
    case 'complete':
      return doComplete(ctx, id, item, input, now);
    case 'reopen':
      return doReopen(ctx, id, item, input, now);
    case 'snooze':
      return doSnooze(ctx, id, item, input, now);
    case 'reschedule':
      return doReschedule(ctx, id, item, input, now);
    case 'edit':
      return doEdit(ctx, id, item, input, now);
    case 'forget':
      return doForget(ctx, id, item, input, now);
    default:
      return invalidResult(now, `Unknown action "${String(input.action)}".`);
  }
}

/** Push-button actions from src/links.ts / the `/a/<token>` HTTP endpoint. */
export async function applyLinkAction(
  ctx: ClaudiaContext,
  action: 'done' | 'snooze1h' | 'tomorrow',
  id: string,
): Promise<UpdateResult> {
  const now = nowLabel(ctx);
  const cleanId = stripCaret(id);
  const item = ctx.index.getItem(cleanId);
  if (!item) return notFoundResult(now, cleanId);

  if (item.status === 'done') {
    return {
      now,
      status: 'ok',
      id: cleanId,
      message: 'Already done.',
      item: itemView(item, { vaultName: ctx.vaultName, today: todayOf(ctx) }),
    };
  }

  if (action === 'done') {
    return update(ctx, { action: 'complete', id: cleanId, surface: 'push' });
  }

  const zone = zoneOf(ctx);
  const nowDate = ctx.clock.now();

  if (action === 'snooze1h') {
    const untilLocal = instantToLocal(new Date(nowDate.getTime() + 60 * 60_000), zone);
    if (item.reminder && untilLocal <= item.reminder) {
      return update(ctx, {
        action: 'reschedule',
        id: cleanId,
        remind_at: untilLocal,
        surface: 'push',
      });
    }
    return update(ctx, { action: 'snooze', id: cleanId, until: untilLocal, surface: 'push' });
  }

  const tomorrowDate = addDays(todayOf(ctx), 1);
  const timeOfDay = item.reminder ? item.reminder.slice(11) : '09:00';
  const untilLocal = `${tomorrowDate} ${timeOfDay}`;
  return update(ctx, { action: 'snooze', id: cleanId, until: untilLocal, surface: 'push' });
}
