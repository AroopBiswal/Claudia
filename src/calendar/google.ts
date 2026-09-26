// Google Calendar v3 adapter, scoped to https://www.googleapis.com/auth/calendar.app.created
// (Claudia may only touch calendars it created itself). See src/calendar/auth.ts for the
// one-time OAuth flow that produces the tokens this module consumes.
//
// Sources consulted (Calendar API v3 REST reference):
// - Calendars: insert  https://developers.google.com/calendar/api/v3/reference/calendars/insert
// - Calendars: get     https://developers.google.com/calendar/api/v3/reference/calendars/get
// - Events: insert     https://developers.google.com/calendar/api/v3/reference/events/insert
// - Events: patch      https://developers.google.com/calendar/api/v3/reference/events/patch
// - Events: delete     https://developers.google.com/calendar/api/v3/reference/events/delete
// - Handling API errors (404 on missing resource, 410 on a deleted event)
//   https://developers.google.com/calendar/api/guides/errors
// - Token refresh: POST https://oauth2.googleapis.com/token, grant_type=refresh_token
//   https://developers.google.com/identity/protocols/oauth2/native-app

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CLAUDIA_CALENDAR_SUMMARY = 'Claudia';

export interface GoogleClientSecrets {
  client_id: string;
  client_secret: string;
}

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expiry: number; // ms epoch
  scope: string;
}

export interface TokenStore {
  load(): Promise<GoogleTokens | null>;
  save(t: GoogleTokens): Promise<void>;
}

export interface IdStore {
  load(): Promise<string | null>;
  save(id: string): Promise<void>;
}

export interface EventInput {
  title: string;
  date: string; // 'YYYY-MM-DD'
  start: string; // 'HH:mm' local
  end: string; // 'HH:mm' local
  timeZone: string;
  description?: string;
}

export interface CalendarClient {
  ensureCalendar(): Promise<string>;
  createEvent(input: EventInput): Promise<{ eventId: string }>;
  updateEvent(eventId: string, input: EventInput): Promise<void>;
  cancelEvent(eventId: string): Promise<void>;
}

export class CalendarNotConfiguredError extends Error {
  constructor(
    message = 'Google Calendar is not connected yet. Run the calendar-auth command first.',
  ) {
    super(message);
    this.name = 'CalendarNotConfiguredError';
  }
}

export class CalendarNotFoundError extends Error {
  constructor(message = 'The Google Calendar event was not found.') {
    super(message);
    this.name = 'CalendarNotFoundError';
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * A JSON file token store, written atomically (temp file + rename) with mode 0600.
 */
export function fileTokenStore(path: string): TokenStore {
  return {
    async load(): Promise<GoogleTokens | null> {
      try {
        const raw = await readFile(path, 'utf8');
        return JSON.parse(raw) as GoogleTokens;
      } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') {
          return null;
        }
        throw err;
      }
    },
    async save(tokens: GoogleTokens): Promise<void> {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmpPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, path);
    },
  };
}

/**
 * Reads a downloaded Google "Desktop app" OAuth client JSON
 * (`{"installed": {"client_id": ..., "client_secret": ...}}`).
 */
export function readClientSecrets(path: string): GoogleClientSecrets {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as { installed?: { client_id?: string; client_secret?: string } };
  const installed = parsed.installed;
  if (!installed?.client_id || !installed.client_secret) {
    throw new Error(
      `Invalid Google client secrets file at ${path}: expected an "installed" object with client_id and client_secret`,
    );
  }
  return { client_id: installed.client_id, client_secret: installed.client_secret };
}

function toDateTime(date: string, time: string): string {
  return `${date}T${time}:00`;
}

interface EventBody {
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  reminders: { useDefault: true };
}

function buildEventBody(input: EventInput): EventBody {
  if (input.end <= input.start) {
    throw new Error(`Event end time (${input.end}) must be after its start time (${input.start})`);
  }
  const description = input.description
    ? `${input.description}\n\nCreated by Claudia`
    : 'Created by Claudia';
  return {
    summary: input.title,
    description,
    start: { dateTime: toDateTime(input.date, input.start), timeZone: input.timeZone },
    end: { dateTime: toDateTime(input.date, input.end), timeZone: input.timeZone },
    reminders: { useDefault: true },
  };
}

interface RequestOptions {
  method: string;
  body?: string;
}

export function createGoogleCalendarClient(opts: {
  secrets: GoogleClientSecrets;
  tokens: TokenStore;
  idStore: IdStore;
  timeZone: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): CalendarClient {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? ((): Date => new Date());
  const { secrets, tokens: tokenStore, idStore, timeZone } = opts;

  async function getAccessToken(forceRefresh: boolean): Promise<string> {
    const current = await tokenStore.load();
    if (!current) {
      throw new CalendarNotConfiguredError();
    }
    if (!forceRefresh && current.expiry - now().getTime() > 60_000) {
      return current.access_token;
    }
    return refreshAccessToken(current);
  }

  async function refreshAccessToken(current: GoogleTokens): Promise<string> {
    const res = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
        client_id: secrets.client_id,
        client_secret: secrets.client_secret,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Failed to refresh the Google access token: HTTP ${String(res.status)}`);
    }
    const body = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      scope?: string;
    };
    const updated: GoogleTokens = {
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? current.refresh_token,
      expiry: now().getTime() + body.expires_in * 1000,
      scope: body.scope ?? current.scope,
    };
    await tokenStore.save(updated);
    return updated.access_token;
  }

  function sendWithToken(url: string, init: RequestOptions, token: string): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return fetchImpl(url, { method: init.method, headers, body: init.body });
  }

  async function authorizedFetch(url: string, init: RequestOptions): Promise<Response> {
    const token = await getAccessToken(false);
    const res = await sendWithToken(url, init, token);
    if (res.status === 401) {
      const retryToken = await getAccessToken(true);
      return sendWithToken(url, init, retryToken);
    }
    return res;
  }

  async function ensureCalendar(): Promise<string> {
    const storedId = await idStore.load();
    if (storedId) {
      const res = await authorizedFetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(storedId)}`,
        { method: 'GET' },
      );
      if (res.ok) {
        return storedId;
      }
      if (res.status !== 404) {
        throw new Error(`Failed to look up the Claudia calendar: HTTP ${String(res.status)}`);
      }
      // fall through: stored calendar is gone, create a new one below.
    }
    const res = await authorizedFetch(`${CALENDAR_API}/calendars`, {
      method: 'POST',
      body: JSON.stringify({ summary: CLAUDIA_CALENDAR_SUMMARY, timeZone }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create the Claudia calendar: HTTP ${String(res.status)}`);
    }
    const created = (await res.json()) as { id: string };
    await idStore.save(created.id);
    return created.id;
  }

  return {
    ensureCalendar,

    async createEvent(input: EventInput): Promise<{ eventId: string }> {
      const body = buildEventBody(input);
      const calendarId = await ensureCalendar();
      const res = await authorizedFetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      if (!res.ok) {
        throw new Error(`Failed to create the calendar event: HTTP ${String(res.status)}`);
      }
      const created = (await res.json()) as { id: string };
      return { eventId: created.id };
    },

    async updateEvent(eventId: string, input: EventInput): Promise<void> {
      const body = buildEventBody(input);
      const calendarId = await ensureCalendar();
      const res = await authorizedFetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );
      if (res.status === 404 || res.status === 410) {
        throw new CalendarNotFoundError();
      }
      if (!res.ok) {
        throw new Error(`Failed to update the calendar event: HTTP ${String(res.status)}`);
      }
    },

    async cancelEvent(eventId: string): Promise<void> {
      const calendarId = await ensureCalendar();
      const res = await authorizedFetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'DELETE' },
      );
      if (res.ok || res.status === 404 || res.status === 410) {
        return;
      }
      throw new Error(`Failed to cancel the calendar event: HTTP ${String(res.status)}`);
    },
  };
}
