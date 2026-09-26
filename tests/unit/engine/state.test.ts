import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openState, type State } from '../../../src/engine/state.ts';

describe('openState', () => {
  let clock: number;
  let state: State;

  beforeEach(() => {
    clock = Date.parse('2026-09-26T12:00:00.000Z');
    state = openState({ dbPath: ':memory:', now: () => new Date(clock) });
  });

  afterEach(() => {
    state.close();
  });

  function advanceDays(days: number): void {
    clock += days * 86_400_000;
  }

  describe('fired keys', () => {
    it('reports a key as not fired until markFired is called', () => {
      const key = 'reminder:t9x2k:2026-09-29 09:00';
      expect(state.wasFired(key)).toBe(false);
      state.markFired(key, 'reminder');
      expect(state.wasFired(key)).toBe(true);
    });

    it('treats a different effective time as a different key', () => {
      state.markFired('reminder:t9x2k:2026-09-29 09:00', 'reminder');
      expect(state.wasFired('reminder:t9x2k:2026-09-29 10:00')).toBe(false);
    });

    it('markFired is idempotent for the same key', () => {
      const key = 'nudge:t4m1q:2026-10-02';
      state.markFired(key, 'nudge');
      state.markFired(key, 'nudge');
      expect(state.wasFired(key)).toBe(true);
    });
  });

  describe('useNonce', () => {
    it('returns true the first time and false afterwards', () => {
      expect(state.useNonce('abc123')).toBe(true);
      expect(state.useNonce('abc123')).toBe(false);
      expect(state.useNonce('abc123')).toBe(false);
    });

    it('different nonces are independent', () => {
      expect(state.useNonce('a')).toBe(true);
      expect(state.useNonce('b')).toBe(true);
      expect(state.useNonce('a')).toBe(false);
    });
  });

  describe('capture journal', () => {
    it('returns null when there is no capture yet', () => {
      expect(state.lastCapture()).toBeNull();
    });

    it('recordCapture then lastCapture round-trips surface, words and entries', () => {
      const id = state.recordCapture({
        surface: 'iPhone chat',
        words: 'remind me to call the dentist',
        entries: [{ id: 't9x2k', path: 'Tasks/To do.md' }],
      });
      expect(id).toBeGreaterThan(0);

      const last = state.lastCapture();
      expect(last).not.toBeNull();
      expect(last?.captureId).toBe(id);
      expect(last?.entries).toEqual([{ id: 't9x2k', path: 'Tasks/To do.md' }]);
      expect(typeof last?.at).toBe('string');
    });

    it('lastCapture returns the most recent capture with at least one entry', () => {
      state.recordCapture({
        surface: null,
        words: null,
        entries: [{ id: 'a1', path: 'Tasks/To do.md' }],
      });
      const second = state.recordCapture({
        surface: null,
        words: null,
        entries: [{ id: 'a2', path: 'Tasks/To do.md' }],
      });

      expect(state.lastCapture()?.captureId).toBe(second);
    });

    it('skips a capture with zero entries when looking for the last one', () => {
      const withEntry = state.recordCapture({
        surface: null,
        words: null,
        entries: [{ id: 'a1', path: 'Tasks/To do.md' }],
      });
      state.recordCapture({ surface: null, words: null, entries: [] });

      expect(state.lastCapture()?.captureId).toBe(withEntry);
    });

    it('markCaptureUndone excludes a capture from lastCapture, revealing the one before it', () => {
      const first = state.recordCapture({
        surface: null,
        words: null,
        entries: [{ id: 'a1', path: 'Tasks/To do.md' }],
      });
      const second = state.recordCapture({
        surface: null,
        words: null,
        entries: [{ id: 'a2', path: 'Tasks/To do.md' }],
      });

      expect(state.lastCapture()?.captureId).toBe(second);
      state.markCaptureUndone(second);
      expect(state.lastCapture()?.captureId).toBe(first);
      state.markCaptureUndone(first);
      expect(state.lastCapture()).toBeNull();
    });
  });

  describe('calendar links', () => {
    it('returns null for an unknown id', () => {
      expect(state.getCalendarLink('a3k9p')).toBeNull();
    });

    it('setCalendarLink creates a link, retrievable by id and via calendarLinks()', () => {
      state.setCalendarLink({
        id: 'a3k9p',
        eventId: 'evt-1',
        title: 'Dentist cleaning',
        date: '2026-09-29',
        start: '15:00',
        end: '16:00',
        status: 'synced',
        error: null,
      });

      const link = state.getCalendarLink('a3k9p');
      expect(link).toMatchObject({
        id: 'a3k9p',
        eventId: 'evt-1',
        title: 'Dentist cleaning',
        date: '2026-09-29',
        start: '15:00',
        end: '16:00',
        status: 'synced',
        error: null,
      });
      expect(typeof link?.updatedAt).toBe('string');
      expect(state.calendarLinks()).toHaveLength(1);
    });

    it('setCalendarLink upserts an existing id in place', () => {
      state.setCalendarLink({
        id: 'a3k9p',
        eventId: null,
        title: 'Dentist',
        date: '2026-09-29',
        start: '15:00',
        end: '16:00',
        status: 'pending',
        error: null,
      });
      state.setCalendarLink({
        id: 'a3k9p',
        eventId: 'evt-2',
        title: 'Dentist cleaning',
        date: '2026-09-29',
        start: '15:00',
        end: '16:00',
        status: 'synced',
        error: null,
      });

      expect(state.calendarLinks()).toHaveLength(1);
      expect(state.getCalendarLink('a3k9p')?.eventId).toBe('evt-2');
      expect(state.getCalendarLink('a3k9p')?.status).toBe('synced');
    });

    it('deleteCalendarLink removes it', () => {
      state.setCalendarLink({
        id: 'a3k9p',
        eventId: 'evt-1',
        title: 'Dentist',
        date: '2026-09-29',
        start: '15:00',
        end: '16:00',
        status: 'synced',
        error: null,
      });
      state.deleteCalendarLink('a3k9p');
      expect(state.getCalendarLink('a3k9p')).toBeNull();
      expect(state.calendarLinks()).toHaveLength(0);
    });
  });

  describe('kv', () => {
    it('returns null for a missing key', () => {
      expect(state.getKv('brief:lastPublished')).toBeNull();
    });

    it('setKv then getKv round-trips, and overwrites on a second set', () => {
      state.setKv('brief:lastPublished', '2026-09-26');
      expect(state.getKv('brief:lastPublished')).toBe('2026-09-26');
      state.setKv('brief:lastPublished', '2026-09-27');
      expect(state.getKv('brief:lastPublished')).toBe('2026-09-27');
    });
  });

  describe('prune', () => {
    it('removes fired keys and nonces older than N days, keeping newer ones', () => {
      state.markFired('reminder:old:2026-09-01 09:00', 'reminder');
      state.useNonce('old-nonce');

      advanceDays(10);
      state.markFired('reminder:new:2026-10-06 09:00', 'reminder');
      state.useNonce('new-nonce');

      state.prune(5);

      expect(state.wasFired('reminder:old:2026-09-01 09:00')).toBe(false);
      expect(state.wasFired('reminder:new:2026-10-06 09:00')).toBe(true);
      // A pruned nonce is usable again; a retained one is still spent.
      expect(state.useNonce('old-nonce')).toBe(true);
      expect(state.useNonce('new-nonce')).toBe(false);
    });
  });

  describe('db handle', () => {
    it('exposes the underlying DatabaseSync so createOAuthStore can share it', () => {
      expect(state.db).toBeDefined();
      const row = state.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'")
        .get();
      expect(row).toBeDefined();
    });
  });
});

describe('openState with a real file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claudia-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the parent directory and the db file', () => {
    const dbPath = join(dir, 'nested', 'state.db');
    const state = openState({ dbPath });
    expect(existsSync(dbPath)).toBe(true);
    const dirMode = statSync(join(dir, 'nested')).mode & 0o777;
    expect(dirMode).toBe(0o700);
    state.close();
  });

  it('reopening the db file keeps data', () => {
    const dbPath = join(dir, 'state.db');
    const first = openState({ dbPath });
    first.setKv('greeting', 'hello');
    first.markFired('reminder:t1:2026-01-01 09:00', 'reminder');
    first.close();

    const second = openState({ dbPath });
    expect(second.getKv('greeting')).toBe('hello');
    expect(second.wasFired('reminder:t1:2026-01-01 09:00')).toBe(true);
    second.close();
  });
});
