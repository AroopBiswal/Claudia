// Keeps Claudia-calendar events in step with appointment lines
// (vault-format.md section 8). The mapping (block id -> event id, last
// synced title/date/times) lives in state (src/engine/state.ts), never in
// the vault.

import type { Index } from '../engine/index.ts';
import type { State } from '../engine/state.ts';
import type { CalendarStatus, CalendarSync } from '../services/context.ts';
import { CalendarNotConfiguredError, type CalendarClient } from './google.ts';

export interface CreateCalendarSyncOptions {
  client: CalendarClient | null;
  state: State;
  index: Index;
  zone: () => string;
  log: (message: string) => void;
}

// vault-format.md 4.3: "tags and links stay in [the description]", so an
// appointment's `#appointment` tag is part of item.text. Strip it (and any
// other tag) for the calendar event title.
const TAG_RE = /(?<![\p{L}\p{N}_])#[\p{L}\p{N}_/-]+/gu;

function titleFromText(text: string): string {
  return text.replace(TAG_RE, '').replace(/\s+/g, ' ').trim();
}

function addMinutesToClock(hhmm: string, minutes: number): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m + minutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function createCalendarSync(opts: CreateCalendarSyncOptions): CalendarSync {
  const { client, state, index, zone, log } = opts;

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  async function upsert(id: string): Promise<CalendarStatus> {
    const item = index.getItem(id);
    if (!item || item.kind !== 'appointment' || !item.appointment) {
      return 'pending';
    }

    const { date, start } = item.appointment;
    const end = item.appointment.end ?? addMinutesToClock(start, 60);
    const title = titleFromText(item.text);
    const existing = state.getCalendarLink(id);

    if (!client) {
      state.setCalendarLink({
        id,
        eventId: existing?.eventId ?? null,
        title,
        date,
        start,
        end,
        status: 'pending',
        error: null,
      });
      return 'not_configured';
    }

    const input = { title, date, start, end, timeZone: zone() };

    try {
      if (existing?.eventId) {
        const unchanged =
          existing.status === 'synced' &&
          existing.title === title &&
          existing.date === date &&
          existing.start === start &&
          existing.end === end;
        if (unchanged) return 'updated';

        await client.updateEvent(existing.eventId, input);
        state.setCalendarLink({
          id,
          eventId: existing.eventId,
          title,
          date,
          start,
          end,
          status: 'synced',
          error: null,
        });
        return 'updated';
      }

      const created = await client.createEvent(input);
      state.setCalendarLink({
        id,
        eventId: created.eventId,
        title,
        date,
        start,
        end,
        status: 'synced',
        error: null,
      });
      return 'created';
    } catch (err) {
      if (err instanceof CalendarNotConfiguredError) {
        state.setCalendarLink({
          id,
          eventId: existing?.eventId ?? null,
          title,
          date,
          start,
          end,
          status: 'pending',
          error: null,
        });
        return 'not_configured';
      }
      const message = errorMessage(err);
      state.setCalendarLink({
        id,
        eventId: existing?.eventId ?? null,
        title,
        date,
        start,
        end,
        status: 'error',
        error: message,
      });
      log(`calendar sync error for ${id}: ${message}`);
      return 'pending';
    }
  }

  async function cancel(id: string): Promise<void> {
    const link = state.getCalendarLink(id);
    if (!link) return;
    if (client && link.eventId) {
      try {
        await client.cancelEvent(link.eventId);
      } catch (err) {
        log(`calendar cancel error for ${id}: ${errorMessage(err)}`);
      }
    }
    state.deleteCalendarLink(id);
  }

  async function reconcile(): Promise<void> {
    try {
      const openAppointments = index.appointments({
        from: '0000-01-01',
        to: '9999-12-31',
        includeDone: false,
      });
      const openIds = new Set(
        openAppointments.map((a) => a.id).filter((id): id is string => id !== null),
      );

      for (const link of state.calendarLinks()) {
        if (openIds.has(link.id)) continue;
        if (client && link.eventId) {
          try {
            await client.cancelEvent(link.eventId);
          } catch (err) {
            log(`calendar reconcile: cancel failed for ${link.id}: ${errorMessage(err)}`);
          }
        }
        state.deleteCalendarLink(link.id);
      }

      for (const item of openAppointments) {
        if (!item.id) continue;
        try {
          await upsert(item.id);
        } catch (err) {
          log(`calendar reconcile: upsert failed for ${item.id}: ${errorMessage(err)}`);
        }
      }
    } catch (err) {
      log(`calendar reconcile failed: ${errorMessage(err)}`);
    }
  }

  return { upsert, cancel, reconcile };
}
