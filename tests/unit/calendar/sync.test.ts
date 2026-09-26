import { afterEach, describe, expect, it } from 'vitest';
import { openIndex, type Index } from '../../../src/engine/index.ts';
import { openState, type State } from '../../../src/engine/state.ts';
import { createVaultWriter, type VaultWriter } from '../../../src/engine/writer.ts';
import { createCalendarSync } from '../../../src/calendar/sync.ts';
import {
  CalendarNotConfiguredError,
  type CalendarClient,
  type EventInput,
} from '../../../src/calendar/google.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { makeScratchVault, type ScratchVault } from '../../helpers/scratch-vault.ts';

interface FakeClientCall {
  method: 'create' | 'update' | 'cancel';
  eventId?: string;
  input?: EventInput;
}

class FakeGoogleClient implements CalendarClient {
  calls: FakeClientCall[] = [];
  nextEventId = 1;
  failNext: Error | null = null;

  ensureCalendar(): Promise<string> {
    return Promise.resolve('cal-1');
  }

  createEvent(input: EventInput): Promise<{ eventId: string }> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const eventId = `evt-${String(this.nextEventId)}`;
    this.nextEventId += 1;
    this.calls.push({ method: 'create', input });
    return Promise.resolve({ eventId });
  }

  updateEvent(eventId: string, input: EventInput): Promise<void> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.calls.push({ method: 'update', eventId, input });
    return Promise.resolve();
  }

  cancelEvent(eventId: string): Promise<void> {
    this.calls.push({ method: 'cancel', eventId });
    return Promise.resolve();
  }
}

interface Harness {
  index: Index;
  state: State;
  writer: VaultWriter;
  vault: ScratchVault;
  clock: FakeClock;
  cleanup(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const vault = await makeScratchVault({
    'Tasks/Appointments.md': '# Appointments\n\n',
    '_claudia/Settings.md':
      '---\nclaudia: settings\n---\n# Settings\n\n- Time zone: America/Los_Angeles\n',
  });
  const clock = new FakeClock('2026-09-26T17:00:00Z');
  const now = () => clock.now();
  const index = openIndex({ dbPath: ':memory:', vaultDir: vault.dir, now });
  await index.rebuild();
  const state = openState({ dbPath: ':memory:', now });
  const writer = createVaultWriter({ vaultDir: vault.dir, now, quietMs: 0 });
  return {
    index,
    state,
    writer,
    vault,
    clock,
    async cleanup() {
      index.close();
      state.close();
      await vault.cleanup();
    },
  };
}

async function addAppointment(h: Harness, line: string): Promise<void> {
  await h.writer.append('Tasks/Appointments.md', [line]);
  await h.index.reindexFile('Tasks/Appointments.md');
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('calendar sync: upsert', () => {
  it('creates an event for a new appointment and stores the link', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001');
    const client = new FakeGoogleClient();
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });

    const status = await sync.upsert('a0001');
    expect(status).toBe('created');
    expect(client.calls).toEqual([
      {
        method: 'create',
        input: {
          title: 'Standup',
          date: '2026-09-29',
          start: '09:00',
          end: '09:30',
          timeZone: 'America/Los_Angeles',
        },
      },
    ]);
    const link = h.state.getCalendarLink('a0001');
    expect(link).toMatchObject({ id: 'a0001', eventId: 'evt-1', status: 'synced' });
  });

  it('updates the event when the title or times change', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001');
    const client = new FakeGoogleClient();
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    await sync.upsert('a0001');

    await h.writer.editById('Tasks/Appointments.md', 'a0001', (raw) =>
      raw.replace('09:00-09:30', '10:00-10:30'),
    );
    await h.index.reindexFile('Tasks/Appointments.md');

    const status = await sync.upsert('a0001');
    expect(status).toBe('updated');
    expect(client.calls[1]).toEqual({
      method: 'update',
      eventId: 'evt-1',
      input: {
        title: 'Standup',
        date: '2026-09-29',
        start: '10:00',
        end: '10:30',
        timeZone: 'America/Los_Angeles',
      },
    });
  });

  it('is a no-op (still "updated") when nothing changed', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001');
    const client = new FakeGoogleClient();
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    await sync.upsert('a0001');
    const status = await sync.upsert('a0001');
    expect(status).toBe('updated');
    expect(client.calls).toHaveLength(1); // no second API call
  });

  it('defaults the end time to start + 60 minutes when the line has none', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00 ^a0001');
    const client = new FakeGoogleClient();
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    await sync.upsert('a0001');
    expect(client.calls[0]?.input?.end).toBe('10:00');
  });

  it('reports not_configured and stores a pending link when there is no client', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001');
    const sync = createCalendarSync({
      client: null,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    const status = await sync.upsert('a0001');
    expect(status).toBe('not_configured');
    expect(h.state.getCalendarLink('a0001')).toMatchObject({ status: 'pending', eventId: null });
  });

  it('reports not_configured when the client throws CalendarNotConfiguredError', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001');
    const client = new FakeGoogleClient();
    client.failNext = new CalendarNotConfiguredError();
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    const status = await sync.upsert('a0001');
    expect(status).toBe('not_configured');
  });

  it('reports pending and records the error when the client throws', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001');
    const client = new FakeGoogleClient();
    client.failNext = new Error('network down');
    const logs: string[] = [];
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: (m) => logs.push(m),
    });
    const status = await sync.upsert('a0001');
    expect(status).toBe('pending');
    expect(h.state.getCalendarLink('a0001')).toMatchObject({
      status: 'error',
      error: 'network down',
    });
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe('calendar sync: cancel', () => {
  it('cancels the event and deletes the link', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001');
    const client = new FakeGoogleClient();
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    await sync.upsert('a0001');
    await sync.cancel('a0001');
    expect(client.calls.some((c) => c.method === 'cancel' && c.eventId === 'evt-1')).toBe(true);
    expect(h.state.getCalendarLink('a0001')).toBeNull();
  });

  it('is a no-op when there is no link', async () => {
    h = await makeHarness();
    const client = new FakeGoogleClient();
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    await expect(sync.cancel('a9999')).resolves.toBeUndefined();
  });
});

describe('calendar sync: reconcile', () => {
  it('cancels and forgets links whose appointment line is gone', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001');
    const client = new FakeGoogleClient();
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    await sync.upsert('a0001');

    await h.writer.editById('Tasks/Appointments.md', 'a0001', () => null);
    await h.index.reindexFile('Tasks/Appointments.md');

    await sync.reconcile();
    expect(client.calls.some((c) => c.method === 'cancel' && c.eventId === 'evt-1')).toBe(true);
    expect(h.state.getCalendarLink('a0001')).toBeNull();
  });

  it('retries a pending link once the client is configured', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001');
    const noClientSync = createCalendarSync({
      client: null,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    await noClientSync.upsert('a0001');
    expect(h.state.getCalendarLink('a0001')?.status).toBe('pending');

    const client = new FakeGoogleClient();
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    await sync.reconcile();

    expect(h.state.getCalendarLink('a0001')).toMatchObject({ status: 'synced', eventId: 'evt-1' });
  });

  it('retries an errored link and never throws', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001');
    const client = new FakeGoogleClient();
    client.failNext = new Error('boom');
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    await sync.upsert('a0001');
    expect(h.state.getCalendarLink('a0001')?.status).toBe('error');

    await expect(sync.reconcile()).resolves.toBeUndefined();
    expect(h.state.getCalendarLink('a0001')).toMatchObject({ status: 'synced', eventId: 'evt-1' });
  });

  it('creates events for open appointments that were never synced', async () => {
    h = await makeHarness();
    await addAppointment(h, '- [ ] Standup #appointment 🗓️ 2026-09-29 09:00-09:30 ^a0001');
    const client = new FakeGoogleClient();
    const sync = createCalendarSync({
      client,
      state: h.state,
      index: h.index,
      zone: () => 'America/Los_Angeles',
      log: () => {},
    });
    await sync.reconcile();
    expect(h.state.getCalendarLink('a0001')).toMatchObject({ status: 'synced', eventId: 'evt-1' });
  });
});
