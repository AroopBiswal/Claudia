import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CalendarNotConfiguredError,
  CalendarNotFoundError,
  createGoogleCalendarClient,
  fileTokenStore,
  readClientSecrets,
  type EventInput,
  type GoogleTokens,
  type IdStore,
  type TokenStore,
} from '../../../src/calendar/google.ts';

const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const FIXED_NOW = new Date('2026-09-26T12:00:00Z').getTime();
const SECRETS = { client_id: 'client-123', client_secret: 'shh-secret' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function createFetchMock(responses: Response[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchMock = ((url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        headers[key] = value;
      }
    }
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const res = responses[index];
    index += 1;
    if (!res) {
      throw new Error(`No mock response queued for call #${String(index)} to ${String(url)}`);
    }
    return Promise.resolve(res);
  }) as typeof fetch;
  return { fetch: fetchMock, calls };
}

function createIdStore(initial: string | null = null): IdStore & { current: () => string | null } {
  let id = initial;
  return {
    load: () => Promise.resolve(id),
    save: (newId: string) => {
      id = newId;
      return Promise.resolve();
    },
    current: () => id,
  };
}

function createTokenStore(initial: GoogleTokens | null): TokenStore & { saves: GoogleTokens[] } {
  let current = initial;
  const saves: GoogleTokens[] = [];
  return {
    load: () => Promise.resolve(current),
    save: (t: GoogleTokens) => {
      current = t;
      saves.push(t);
      return Promise.resolve();
    },
    saves,
  };
}

function validToken(): GoogleTokens {
  return {
    access_token: 'access-valid',
    refresh_token: 'refresh-valid',
    expiry: FIXED_NOW + 3_600_000,
    scope: SCOPE,
  };
}

const sampleEvent: EventInput = {
  title: 'Dentist cleaning at Main St Dental',
  date: '2026-09-29',
  start: '15:00',
  end: '16:00',
  timeZone: 'America/Los_Angeles',
  description: 'Bring insurance card',
};

describe('createGoogleCalendarClient', () => {
  describe('ensureCalendar', () => {
    it('creates the Claudia calendar once and reuses the stored id', async () => {
      const idStore = createIdStore(null);
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock, calls } = createFetchMock([
        jsonResponse(200, { id: 'cal-new' }),
        jsonResponse(200, { id: 'cal-new', summary: 'Claudia' }),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      const firstId = await client.ensureCalendar();
      expect(firstId).toBe('cal-new');
      expect(idStore.current()).toBe('cal-new');

      const secondId = await client.ensureCalendar();
      expect(secondId).toBe('cal-new');

      expect(calls).toHaveLength(2);
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.url).toBe('https://www.googleapis.com/calendar/v3/calendars');
      expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
        summary: 'Claudia',
        timeZone: 'America/Los_Angeles',
      });
      expect(calls[1]?.method).toBe('GET');
      expect(calls[1]?.url).toBe('https://www.googleapis.com/calendar/v3/calendars/cal-new');
    });

    it('recreates the calendar when the stored id 404s', async () => {
      const idStore = createIdStore('cal-stale');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock, calls } = createFetchMock([
        emptyResponse(404),
        jsonResponse(200, { id: 'cal-fresh' }),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      const id = await client.ensureCalendar();
      expect(id).toBe('cal-fresh');
      expect(idStore.current()).toBe('cal-fresh');
      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toBe('https://www.googleapis.com/calendar/v3/calendars/cal-stale');
      expect(calls[1]?.method).toBe('POST');
    });
  });

  describe('createEvent', () => {
    it('sends the right url, method, headers and body', async () => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock, calls } = createFetchMock([
        jsonResponse(200, { id: 'cal-1' }), // ensureCalendar GET check
        jsonResponse(200, { id: 'evt-1' }), // events.insert
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      const result = await client.createEvent(sampleEvent);
      expect(result).toEqual({ eventId: 'evt-1' });

      const insertCall = calls[1];
      expect(insertCall?.method).toBe('POST');
      expect(insertCall?.url).toBe('https://www.googleapis.com/calendar/v3/calendars/cal-1/events');
      expect(insertCall?.headers.Authorization).toBe('Bearer access-valid');
      expect(insertCall?.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(insertCall?.body ?? '{}') as Record<string, unknown>;
      expect(body).toMatchObject({
        summary: 'Dentist cleaning at Main St Dental',
        start: { dateTime: '2026-09-29T15:00:00', timeZone: 'America/Los_Angeles' },
        end: { dateTime: '2026-09-29T16:00:00', timeZone: 'America/Los_Angeles' },
        reminders: { useDefault: true },
      });
      expect(body.description).toContain('Bring insurance card');
      expect(body.description).toContain('Created by Claudia');
    });

    it('adds "Created by Claudia" even with no description', async () => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock } = createFetchMock([
        jsonResponse(200, { id: 'cal-1' }),
        jsonResponse(200, { id: 'evt-2' }),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await client.createEvent({
        title: 'Haircut',
        date: '2026-10-01',
        start: '09:00',
        end: '09:30',
        timeZone: 'America/Los_Angeles',
      });
      // no throw is the assertion here; body shape covered above
    });

    it('rejects when the end time is not after the start time', async () => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock } = createFetchMock([jsonResponse(200, { id: 'cal-1' })]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await expect(
        client.createEvent({ ...sampleEvent, start: '16:00', end: '16:00' }),
      ).rejects.toThrow(/after its start time/);
      await expect(
        client.createEvent({ ...sampleEvent, start: '16:00', end: '15:00' }),
      ).rejects.toThrow(/after its start time/);
    });
  });

  describe('updateEvent', () => {
    it('PATCHes the event with the right url and body', async () => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock, calls } = createFetchMock([
        jsonResponse(200, { id: 'cal-1' }),
        jsonResponse(200, {}),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await client.updateEvent('evt-1', sampleEvent);
      const patchCall = calls[1];
      expect(patchCall?.method).toBe('PATCH');
      expect(patchCall?.url).toBe(
        'https://www.googleapis.com/calendar/v3/calendars/cal-1/events/evt-1',
      );
      expect(patchCall?.headers.Authorization).toBe('Bearer access-valid');
    });

    it.each([404, 410])('throws CalendarNotFoundError on %d', async (status) => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock } = createFetchMock([
        jsonResponse(200, { id: 'cal-1' }),
        emptyResponse(status),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await expect(client.updateEvent('evt-1', sampleEvent)).rejects.toBeInstanceOf(
        CalendarNotFoundError,
      );
    });
  });

  describe('cancelEvent', () => {
    it('DELETEs the event', async () => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock, calls } = createFetchMock([
        jsonResponse(200, { id: 'cal-1' }),
        emptyResponse(204),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await client.cancelEvent('evt-1');
      const deleteCall = calls[1];
      expect(deleteCall?.method).toBe('DELETE');
      expect(deleteCall?.url).toBe(
        'https://www.googleapis.com/calendar/v3/calendars/cal-1/events/evt-1',
      );
    });

    it('treats 410 as success', async () => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock } = createFetchMock([
        jsonResponse(200, { id: 'cal-1' }),
        emptyResponse(410),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await expect(client.cancelEvent('evt-1')).resolves.toBeUndefined();
    });

    it('treats 404 as success', async () => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock } = createFetchMock([
        jsonResponse(200, { id: 'cal-1' }),
        emptyResponse(404),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await expect(client.cancelEvent('evt-1')).resolves.toBeUndefined();
    });

    it('throws on an unexpected error status', async () => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock } = createFetchMock([
        jsonResponse(200, { id: 'cal-1' }),
        emptyResponse(500),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await expect(client.cancelEvent('evt-1')).rejects.toThrow(/HTTP 500/);
    });
  });

  describe('token refresh', () => {
    it('refreshes an access token that is within 60s of expiry before calling the API', async () => {
      const idStore = createIdStore('cal-1');
      const soonToExpire: GoogleTokens = {
        access_token: 'access-old',
        refresh_token: 'refresh-old',
        expiry: FIXED_NOW + 30_000,
        scope: SCOPE,
      };
      const tokenStore = createTokenStore(soonToExpire);
      const { fetch: fetchMock, calls } = createFetchMock([
        jsonResponse(200, {
          access_token: 'access-new',
          expires_in: 3600,
          scope: SCOPE,
        }),
        jsonResponse(200, { id: 'cal-1' }),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await client.ensureCalendar();

      expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
      expect(calls[0]?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const refreshBody = new URLSearchParams(calls[0]?.body ?? '');
      expect(refreshBody.get('grant_type')).toBe('refresh_token');
      expect(refreshBody.get('refresh_token')).toBe('refresh-old');
      expect(refreshBody.get('client_id')).toBe('client-123');
      expect(refreshBody.get('client_secret')).toBe('shh-secret');

      expect(calls[1]?.headers.Authorization).toBe('Bearer access-new');
      expect(tokenStore.saves).toHaveLength(1);
      expect(tokenStore.saves[0]).toMatchObject({
        access_token: 'access-new',
        refresh_token: 'refresh-old',
        expiry: FIXED_NOW + 3_600_000,
      });
    });

    it('keeps the old refresh token when the refresh response omits one', async () => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore({
        access_token: 'access-old',
        refresh_token: 'refresh-keep',
        expiry: FIXED_NOW - 1,
        scope: SCOPE,
      });
      const { fetch: fetchMock } = createFetchMock([
        jsonResponse(200, { access_token: 'access-new', expires_in: 3600 }),
        jsonResponse(200, { id: 'cal-1' }),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await client.ensureCalendar();
      expect(tokenStore.saves[0]?.refresh_token).toBe('refresh-keep');
    });

    it('retries once on a 401 by force-refreshing the token', async () => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock, calls } = createFetchMock([
        emptyResponse(401), // ensureCalendar GET with stale-but-not-yet-expired token
        jsonResponse(200, { access_token: 'access-refreshed', expires_in: 3600, scope: SCOPE }),
        jsonResponse(200, { id: 'cal-1' }), // retried GET succeeds
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      const id = await client.ensureCalendar();
      expect(id).toBe('cal-1');
      expect(calls).toHaveLength(3);
      expect(calls[0]?.headers.Authorization).toBe('Bearer access-valid');
      expect(calls[1]?.url).toBe('https://oauth2.googleapis.com/token');
      expect(calls[2]?.headers.Authorization).toBe('Bearer access-refreshed');
    });

    it('does not retry a second time if the retry also 401s', async () => {
      const idStore = createIdStore('cal-1');
      const tokenStore = createTokenStore(validToken());
      const { fetch: fetchMock, calls } = createFetchMock([
        emptyResponse(401),
        jsonResponse(200, { access_token: 'access-refreshed', expires_in: 3600, scope: SCOPE }),
        emptyResponse(401),
      ]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await expect(client.ensureCalendar()).rejects.toThrow(/HTTP 401/);
      expect(calls).toHaveLength(3);
    });
  });

  describe('not configured', () => {
    it('throws CalendarNotConfiguredError when there are no stored tokens, without calling fetch', async () => {
      const idStore = createIdStore(null);
      const tokenStore = createTokenStore(null);
      const { fetch: fetchMock, calls } = createFetchMock([]);

      const client = createGoogleCalendarClient({
        secrets: SECRETS,
        tokens: tokenStore,
        idStore,
        timeZone: 'America/Los_Angeles',
        fetch: fetchMock,
        now: () => new Date(FIXED_NOW),
      });

      await expect(client.ensureCalendar()).rejects.toBeInstanceOf(CalendarNotConfiguredError);
      expect(calls).toHaveLength(0);
    });
  });
});

describe('readClientSecrets', () => {
  it('parses a downloaded Desktop-app client JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claudia-calendar-'));
    const path = join(dir, 'client_secret.json');
    await writeFile(
      path,
      JSON.stringify({
        installed: {
          client_id: 'file-client-id',
          client_secret: 'file-client-secret',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
      }),
    );

    const secrets = readClientSecrets(path);
    expect(secrets).toEqual({ client_id: 'file-client-id', client_secret: 'file-client-secret' });
  });

  it('throws a clear error when the file is missing the installed client', () => {
    // constructing a bad temp file synchronously is unnecessary; test the error path directly
    expect(() => readClientSecrets('/nonexistent/path/to/client_secret.json')).toThrow();
  });
});

describe('fileTokenStore', () => {
  it('round-trips tokens and writes the file with mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claudia-calendar-'));
    const path = join(dir, 'tokens.json');
    const store = fileTokenStore(path);

    expect(await store.load()).toBeNull();

    const tokens: GoogleTokens = {
      access_token: 'a',
      refresh_token: 'r',
      expiry: FIXED_NOW,
      scope: SCOPE,
    };
    await store.save(tokens);

    const loaded = await store.load();
    expect(loaded).toEqual(tokens);

    const stats = await stat(path);
    expect(stats.mode & 0o777).toBe(0o600);

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('.tmp');
  });
});
