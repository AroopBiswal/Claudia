// agenda (docs/tools.md): time-based read-only views over the index, plus
// the morning brief payload. Every item is shaped as ItemView (recall
// shape); `renderAgendaText` renders the same result as a short list for
// the tool's text content block.
//
// Async throughout: the "recent" and "brief" views read Log notes from disk
// (services/recent.ts) alongside the synchronous index queries.

import { z } from 'zod';
import type { IndexedItem } from '../engine/index.ts';
import { parseRepeat } from '../vault/repeat.ts';
import { addDays, type LocalDate } from '../time/format.ts';
import { LAYOUT } from '../vault/layout.ts';
import {
  currentSettings,
  nowLabel,
  nowLocalOf,
  todayOf,
  zoneOf,
  type ClaudiaContext,
} from './context.ts';
import { itemView, type ItemView } from './views.ts';
import { nudgesDue } from './nudges.ts';
import { recentCaptures, type RecentCapture } from './recent.ts';

export const agendaInputSchema = z.object({
  view: z
    .enum(['today', 'overdue', 'upcoming', 'follow_ups', 'recent', 'brief'])
    .describe('Which agenda view to return.'),
  days: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(7)
    .describe('Days ahead for "upcoming", or days back for "recent"; default 7, max 60.'),
});

export type AgendaInput = z.input<typeof agendaInputSchema>;
export type AgendaView = z.infer<typeof agendaInputSchema>['view'];

export interface AgendaError {
  error: string;
}

interface AgendaBase {
  now: string;
  timezone: string;
  text: string;
}

export interface TodaySections {
  appointments: ItemView[];
  reminders: ItemView[];
  due: ItemView[];
}

export interface OverdueSections {
  reminders: ItemView[];
  due: ItemView[];
}

export interface UpcomingSections {
  appointments: ItemView[];
  reminders: ItemView[];
  due: ItemView[];
}

export interface FollowUpSections {
  waiting: ItemView[];
  promised: ItemView[];
  nudges_due: ItemView[];
}

export interface TodayAgenda extends AgendaBase, TodaySections {
  view: 'today';
}

export interface OverdueAgenda extends AgendaBase, OverdueSections {
  view: 'overdue';
}

export interface UpcomingAgenda extends AgendaBase, UpcomingSections {
  view: 'upcoming';
}

export interface FollowUpsAgenda extends AgendaBase, FollowUpSections {
  view: 'follow_ups';
}

export interface RecentAgenda extends AgendaBase {
  view: 'recent';
  captures: RecentCapture[];
}

export interface BriefAgenda extends AgendaBase {
  view: 'brief';
  today: TodaySections;
  overdue: OverdueSections;
  upcoming: UpcomingSections;
  follow_ups: FollowUpSections;
  stale_facts: ItemView[];
  recent: RecentCapture[];
  counts: Record<string, number>;
  brief_published_today: boolean;
  settings: { time_zone: string; brief_time: string };
  warnings: string[];
}

export type AgendaResult =
  TodayAgenda | OverdueAgenda | UpcomingAgenda | FollowUpsAgenda | RecentAgenda | BriefAgenda;

function toView(ctx: ClaudiaContext, today: string, item: IndexedItem): ItemView {
  return itemView(item, { vaultName: ctx.vaultName, today });
}

function todaySections(ctx: ClaudiaContext, today: LocalDate): TodaySections {
  const appointments = ctx.index.appointments({ from: today, to: today });
  const reminders = ctx.index.openReminders({ from: `${today} 00:00`, to: `${today} 23:59` });
  const due = ctx.index.openDue({ from: today, to: today });
  return {
    appointments: appointments.map((i) => toView(ctx, today, i)),
    reminders: reminders.map((i) => toView(ctx, today, i)),
    due: due.map((i) => toView(ctx, today, i)),
  };
}

/** "Overdue" = effective reminders in the past (any date) and 📅 due dates strictly before today. */
function overdueSections(ctx: ClaudiaContext, today: LocalDate, nowLocal: string): OverdueSections {
  const reminders = ctx.index.openReminders({ to: nowLocal });
  const due = ctx.index.openDue({ to: addDays(today, -1) });
  return {
    reminders: reminders.map((i) => toView(ctx, today, i)),
    due: due.map((i) => toView(ctx, today, i)),
  };
}

function upcomingSections(ctx: ClaudiaContext, today: LocalDate, days: number): UpcomingSections {
  const from = addDays(today, 1);
  const to = addDays(today, days);
  const appointments = ctx.index.appointments({ from, to });
  const reminders = ctx.index.openReminders({ from: `${from} 00:00`, to: `${to} 23:59` });
  const due = ctx.index.openDue({ from, to });
  return {
    appointments: appointments.map((i) => toView(ctx, today, i)),
    reminders: reminders.map((i) => toView(ctx, today, i)),
    due: due.map((i) => toView(ctx, today, i)),
  };
}

function followUpSections(ctx: ClaudiaContext, today: LocalDate): FollowUpSections {
  const followUps = ctx.index.followUps();
  const waiting = followUps.filter((i) => i.direction === 'waiting');
  const promised = followUps.filter((i) => i.direction === 'promised');
  const nudges = nudgesDue(ctx).map((n) => n.item);
  return {
    waiting: waiting.map((i) => toView(ctx, today, i)),
    promised: promised.map((i) => toView(ctx, today, i)),
    nudges_due: nudges.map((i) => toView(ctx, today, i)),
  };
}

/** Open tasks/follow-ups with a 🔁 rrule text that doesn't parse into a supported family. */
function repeatWarnings(ctx: ClaudiaContext): string[] {
  const warnings: string[] = [];
  for (const path of [LAYOUT.todo, LAYOUT.followUps]) {
    for (const item of ctx.index.itemsInNote(path)) {
      if (item.status !== 'open' || !item.repeat) continue;
      if (!parseRepeat(item.repeat).valid) {
        warnings.push(`Repeat not understood: "${item.repeat}" on "${item.text}".`);
      }
    }
  }
  return warnings;
}

/** Local 'YYYY-MM-DD HH:mm' shifted by `deltaMinutes` (may be negative), no zone/DST math. */
function shiftLocal(local: string, deltaMinutes: number): string {
  const date = local.slice(0, 10);
  const time = local.slice(11);
  const [hStr, mStr] = time.split(':');
  const totalMinutes = Number(hStr ?? '0') * 60 + Number(mStr ?? '0') + deltaMinutes;
  const dayShift = Math.floor(totalMinutes / 1440);
  const minutesOfDay = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  const shiftedDate = addDays(date, dayShift);
  return `${shiftedDate} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Time-based views over the index (docs/tools.md agenda). Read-only. */
export async function agenda(
  ctx: ClaudiaContext,
  input: unknown,
): Promise<AgendaResult | AgendaError> {
  const parsed = agendaInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: z.prettifyError(parsed.error) };
  }

  const { view, days } = parsed.data;
  const now = nowLabel(ctx);
  const timezone = zoneOf(ctx);
  const today = todayOf(ctx);
  const nowLocal = nowLocalOf(ctx);

  switch (view) {
    case 'today': {
      const result: TodayAgenda = { now, timezone, view, ...todaySections(ctx, today), text: '' };
      result.text = renderAgendaText(result);
      return result;
    }
    case 'overdue': {
      const result: OverdueAgenda = {
        now,
        timezone,
        view,
        ...overdueSections(ctx, today, nowLocal),
        text: '',
      };
      result.text = renderAgendaText(result);
      return result;
    }
    case 'upcoming': {
      const result: UpcomingAgenda = {
        now,
        timezone,
        view,
        ...upcomingSections(ctx, today, days),
        text: '',
      };
      result.text = renderAgendaText(result);
      return result;
    }
    case 'follow_ups': {
      const result: FollowUpsAgenda = {
        now,
        timezone,
        view,
        ...followUpSections(ctx, today),
        text: '',
      };
      result.text = renderAgendaText(result);
      return result;
    }
    case 'recent': {
      const captures = await recentCaptures(ctx, days);
      const result: RecentAgenda = { now, timezone, view, captures, text: '' };
      result.text = renderAgendaText(result);
      return result;
    }
    case 'brief': {
      const todaySec = todaySections(ctx, today);
      const overdueSec = overdueSections(ctx, today, nowLocal);
      const upcomingSec = upcomingSections(ctx, today, 7);
      const followUpSec = followUpSections(ctx, today);
      const staleFacts = ctx.index.staleFacts(today).map((i) => toView(ctx, today, i));

      const last48h = await recentCaptures(ctx, 2);
      const cutoff = shiftLocal(nowLocal, -24 * 60);
      const recent = last48h.filter((c) => `${c.date} ${c.time}` >= cutoff);

      const settings = currentSettings(ctx);
      const warnings = [...ctx.index.settings().warnings, ...repeatWarnings(ctx)];

      const counts: Record<string, number> = {
        appointments_today: todaySec.appointments.length,
        reminders_today: todaySec.reminders.length,
        due_today: todaySec.due.length,
        overdue_reminders: overdueSec.reminders.length,
        overdue_due: overdueSec.due.length,
        upcoming_appointments: upcomingSec.appointments.length,
        upcoming_reminders: upcomingSec.reminders.length,
        upcoming_due: upcomingSec.due.length,
        waiting: followUpSec.waiting.length,
        promised: followUpSec.promised.length,
        nudges_due: followUpSec.nudges_due.length,
        stale_facts: staleFacts.length,
        recent: recent.length,
      };

      const result: BriefAgenda = {
        now,
        timezone,
        view,
        today: todaySec,
        overdue: overdueSec,
        upcoming: upcomingSec,
        follow_ups: followUpSec,
        stale_facts: staleFacts,
        recent,
        counts,
        brief_published_today: ctx.state.wasFired(`brief:${today}`),
        settings: { time_zone: settings.timeZone, brief_time: settings.briefTime },
        warnings,
        text: '',
      };
      result.text = renderAgendaText(result);
      return result;
    }
  }
}

function viewLine(item: ItemView): string {
  const bits: string[] = [];
  if (item.reminder) bits.push(`⏰ ${item.reminder}`);
  if (item.appointment) bits.push(`🗓️ ${item.appointment}`);
  if (item.due) bits.push(`📅 ${item.due}`);
  if (item.repeat) bits.push(`🔁 ${item.repeat}`);
  if (item.status !== 'open') bits.push(item.status);
  const suffix = bits.length > 0 ? ` (${bits.join(', ')})` : '';
  const id = item.id ? ` [${item.id}]` : '';
  return `${item.text}${suffix}${id}`;
}

function section(lines: string[], label: string, items: ItemView[]): void {
  lines.push(`${label}:`);
  if (items.length === 0) {
    lines.push('  Nothing.');
    return;
  }
  for (const item of items) lines.push(`  - ${viewLine(item)}`);
}

/** Renders an agenda result as a short list for the tool's text content block. */
export function renderAgendaText(result: AgendaResult): string {
  const lines: string[] = [];
  switch (result.view) {
    case 'today':
      section(lines, 'Appointments', result.appointments);
      section(lines, 'Reminders', result.reminders);
      section(lines, 'Due', result.due);
      break;
    case 'overdue':
      section(lines, 'Overdue reminders', result.reminders);
      section(lines, 'Overdue due', result.due);
      break;
    case 'upcoming':
      section(lines, 'Appointments', result.appointments);
      section(lines, 'Reminders', result.reminders);
      section(lines, 'Due', result.due);
      break;
    case 'follow_ups':
      section(lines, 'Waiting on', result.waiting);
      section(lines, 'Promised', result.promised);
      section(lines, 'Nudges due', result.nudges_due);
      break;
    case 'recent':
      lines.push('Recently captured:');
      if (result.captures.length === 0) {
        lines.push('  Nothing.');
      } else {
        for (const c of result.captures) {
          lines.push(`  - ${c.date} ${c.time} · ${c.text} [${c.id}]`);
        }
      }
      break;
    case 'brief':
      lines.push('Today:');
      section(lines, '  Appointments', result.today.appointments);
      section(lines, '  Reminders', result.today.reminders);
      section(lines, '  Due', result.today.due);
      section(lines, 'Overdue reminders', result.overdue.reminders);
      section(lines, 'Overdue due', result.overdue.due);
      section(lines, 'Waiting on', result.follow_ups.waiting);
      section(lines, 'Promised', result.follow_ups.promised);
      section(lines, 'Nudges due', result.follow_ups.nudges_due);
      section(lines, 'Stale facts', result.stale_facts);
      if (result.warnings.length > 0) {
        lines.push('Warnings:');
        for (const w of result.warnings) lines.push(`  - ${w}`);
      }
      break;
  }
  return lines.join('\n');
}
