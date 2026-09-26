// Operational state store (docs/ROADMAP.md engine/state.ts): fired reminders,
// action-link nonces, the capture undo journal, calendar-link mappings and a
// small key/value table. Lives in ~/.claudia/state.db, separate from the
// vault-derived index. The same DatabaseSync handle is also handed to
// src/auth/store.ts (createOAuthStore) so OAuth tables share this one file.

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CalendarLink {
  id: string;
  eventId: string | null;
  title: string;
  date: string;
  start: string;
  end: string;
  status: 'synced' | 'pending' | 'error';
  error: string | null;
  updatedAt: string;
}

export interface CaptureEntry {
  id: string;
  path: string;
}

export type FiredKind = 'reminder' | 'bundle' | 'nudge' | 'brief' | 'fallback';

export interface State {
  db: DatabaseSync;
  wasFired(key: string): boolean;
  markFired(key: string, kind: FiredKind): void;
  useNonce(nonce: string): boolean;
  recordCapture(c: {
    surface: string | null;
    words: string | null;
    entries: CaptureEntry[];
  }): number;
  lastCapture(): { captureId: number; at: string; entries: CaptureEntry[] } | null;
  markCaptureUndone(captureId: number): void;
  getCalendarLink(id: string): CalendarLink | null;
  setCalendarLink(link: Omit<CalendarLink, 'updatedAt'>): void;
  deleteCalendarLink(id: string): void;
  calendarLinks(): CalendarLink[];
  getKv(key: string): string | null;
  setKv(key: string, value: string): void;
  prune(olderThanDays: number): void;
  close(): void;
}

interface CalendarLinkRow {
  id: string;
  event_id: string | null;
  title: string;
  date: string;
  start: string;
  end: string;
  status: 'synced' | 'pending' | 'error';
  error: string | null;
  updated_at: string;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fired (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      fired_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY,
      used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      surface TEXT,
      words TEXT,
      undone INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS capture_entries (
      capture_id INTEGER NOT NULL,
      id TEXT NOT NULL,
      path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS capture_entries_capture_id ON capture_entries(capture_id);
    CREATE TABLE IF NOT EXISTS calendar_links (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      "start" TEXT NOT NULL,
      "end" TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export function openState(opts: { dbPath: string; now?: () => Date }): State {
  const now = opts.now ?? (() => new Date());
  const isMemory = opts.dbPath === ':memory:';

  if (!isMemory) {
    mkdirSync(dirname(opts.dbPath), { recursive: true, mode: 0o700 });
  }

  const db = new DatabaseSync(opts.dbPath);

  if (!isMemory) {
    try {
      chmodSync(opts.dbPath, 0o600);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);

  function nowMs(): number {
    return now().getTime();
  }

  function wasFired(key: string): boolean {
    const row = db.prepare('SELECT 1 FROM fired WHERE key = ?').get(key);
    return row !== undefined;
  }

  function markFired(key: string, kind: FiredKind): void {
    db.prepare('INSERT OR REPLACE INTO fired (key, kind, fired_at) VALUES (?, ?, ?)').run(
      key,
      kind,
      nowMs(),
    );
  }

  function useNonce(nonce: string): boolean {
    const result = db
      .prepare('INSERT OR IGNORE INTO nonces (nonce, used_at) VALUES (?, ?)')
      .run(nonce, nowMs());
    return Number(result.changes) === 1;
  }

  function recordCapture(c: {
    surface: string | null;
    words: string | null;
    entries: CaptureEntry[];
  }): number {
    const result = db
      .prepare('INSERT INTO captures (at, surface, words, undone) VALUES (?, ?, ?, 0)')
      .run(nowMs(), c.surface, c.words);
    const captureId = Number(result.lastInsertRowid);
    const insertEntry = db.prepare(
      'INSERT INTO capture_entries (capture_id, id, path) VALUES (?, ?, ?)',
    );
    for (const entry of c.entries) {
      insertEntry.run(captureId, entry.id, entry.path);
    }
    return captureId;
  }

  function lastCapture(): { captureId: number; at: string; entries: CaptureEntry[] } | null {
    const rows = db
      .prepare('SELECT id, at FROM captures WHERE undone = 0 ORDER BY id DESC')
      .all() as { id: number; at: number }[];

    for (const row of rows) {
      const entries = db
        .prepare('SELECT id, path FROM capture_entries WHERE capture_id = ?')
        .all(row.id) as unknown as CaptureEntry[];
      if (entries.length > 0) {
        return { captureId: row.id, at: new Date(row.at).toISOString(), entries };
      }
    }
    return null;
  }

  function markCaptureUndone(captureId: number): void {
    db.prepare('UPDATE captures SET undone = 1 WHERE id = ?').run(captureId);
  }

  function rowToCalendarLink(row: CalendarLinkRow): CalendarLink {
    return {
      id: row.id,
      eventId: row.event_id,
      title: row.title,
      date: row.date,
      start: row.start,
      end: row.end,
      status: row.status,
      error: row.error,
      updatedAt: row.updated_at,
    };
  }

  function getCalendarLink(id: string): CalendarLink | null {
    const row = db.prepare('SELECT * FROM calendar_links WHERE id = ?').get(id) as
      CalendarLinkRow | undefined;
    return row ? rowToCalendarLink(row) : null;
  }

  function setCalendarLink(link: Omit<CalendarLink, 'updatedAt'>): void {
    const updatedAt = now().toISOString();
    db.prepare(
      `INSERT INTO calendar_links (id, event_id, title, date, "start", "end", status, error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         event_id = excluded.event_id,
         title = excluded.title,
         date = excluded.date,
         "start" = excluded."start",
         "end" = excluded."end",
         status = excluded.status,
         error = excluded.error,
         updated_at = excluded.updated_at`,
    ).run(
      link.id,
      link.eventId,
      link.title,
      link.date,
      link.start,
      link.end,
      link.status,
      link.error,
      updatedAt,
    );
  }

  function deleteCalendarLink(id: string): void {
    db.prepare('DELETE FROM calendar_links WHERE id = ?').run(id);
  }

  function calendarLinks(): CalendarLink[] {
    const rows = db
      .prepare('SELECT * FROM calendar_links ORDER BY id')
      .all() as unknown as CalendarLinkRow[];
    return rows.map(rowToCalendarLink);
  }

  function getKv(key: string): string | null {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row ? row.value : null;
  }

  function setKv(key: string, value: string): void {
    db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  function prune(olderThanDays: number): void {
    const cutoff = nowMs() - olderThanDays * 86_400_000;
    db.prepare('DELETE FROM fired WHERE fired_at < ?').run(cutoff);
    db.prepare('DELETE FROM nonces WHERE used_at < ?').run(cutoff);
  }

  function close(): void {
    db.close();
  }

  return {
    db,
    wasFired,
    markFired,
    useNonce,
    recordCapture,
    lastCapture,
    markCaptureUndone,
    getCalendarLink,
    setCalendarLink,
    deleteCalendarLink,
    calendarLinks,
    getKv,
    setKv,
    prune,
    close,
  };
}
