// SQLite index (docs/ROADMAP.md engine/index.ts): a rebuildable, FTS5-backed
// index of every item in the vault, plus the read-side queries recall,
// agenda and the scheduler use. The vault is the source of truth; this
// index (~/.claudia/index.db) can be deleted and rebuilt at any time.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseNote } from '../vault/note.ts';
import { extractItems, type ItemKind, type ItemStatus, type VaultItem } from '../vault/items.ts';
import { LAYOUT, conflictCopyBase, isIgnoredPath, noteBasename } from '../vault/layout.ts';
import { DEFAULT_SETTINGS, parseSettings, type Settings } from '../vault/settings.ts';
import type { Rule } from '../vault/rules.ts';

export interface IndexedItem extends VaultItem {
  /** Later of reminder and snooze (lexicographic string compare), null if neither. */
  effectiveReminder: string | null;
  /** VaultItem.people union link targets that resolve to an existing People/<Name>.md, canonical case. */
  people: string[];
  /** Basename of the note the item lives in, without .md. */
  noteTitle: string;
}

export interface SearchQuery {
  query: string;
  kinds?: ItemKind[];
  person?: string;
  includeDone?: boolean;
  limit?: number;
}

export interface Index {
  rebuild(): Promise<{ notes: number; items: number; ms: number }>;
  refresh(): Promise<string[]>;
  reindexFile(relPath: string): Promise<void>;
  indexText(relPath: string, text: string, mtimeMs: number): void;
  removeFile(relPath: string): void;
  getItem(id: string): IndexedItem | null;
  hasId(id: string): boolean;
  itemsInNote(relPath: string): IndexedItem[];
  search(q: SearchQuery): { total: number; results: IndexedItem[] };
  openReminders(range?: { from?: string; to?: string }): IndexedItem[];
  openDue(range: { from?: string; to?: string }): IndexedItem[];
  appointments(range: { from: string; to: string; includeDone?: boolean }): IndexedItem[];
  followUps(opts?: { includeDone?: boolean }): IndexedItem[];
  facts(opts?: { person?: string }): IndexedItem[];
  staleFacts(today: string): IndexedItem[];
  rules(): Rule[];
  settings(): { settings: Settings; warnings: string[] };
  people(): string[];
  duplicateIds(): string[];
  notePaths(): string[];
  stats(): { notes: number; items: number; lastRebuild: string | null };
  close(): void;
}

interface ItemRow {
  id: string | null;
  path: string;
  line_no: number;
  kind: ItemKind;
  status: ItemStatus;
  status_char: string | null;
  text: string;
  raw: string;
  reminder: string | null;
  snooze: string | null;
  effective_reminder: string | null;
  appt_date: string | null;
  appt_start: string | null;
  appt_end: string | null;
  due: string | null;
  created: string | null;
  done: string | null;
  cancelled: string | null;
  repeat: string | null;
  expires: string | null;
  keywords_json: string;
  tags_json: string;
  links_json: string;
  people_json: string;
  direction: VaultItem['direction'];
}

const CURRENT_SCHEMA_VERSION = '1';

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      marker TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT,
      path TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      status_char TEXT,
      text TEXT NOT NULL,
      raw TEXT NOT NULL,
      reminder TEXT,
      snooze TEXT,
      effective_reminder TEXT,
      appt_date TEXT,
      appt_start TEXT,
      appt_end TEXT,
      due TEXT,
      created TEXT,
      done TEXT,
      cancelled TEXT,
      repeat TEXT,
      expires TEXT,
      keywords_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      links_json TEXT NOT NULL,
      people_json TEXT NOT NULL,
      direction TEXT
    );
    CREATE INDEX IF NOT EXISTS items_id_idx ON items(id);
    CREATE INDEX IF NOT EXISTS items_path_idx ON items(path);
    CREATE INDEX IF NOT EXISTS items_kind_status_idx ON items(kind, status);
    CREATE INDEX IF NOT EXISTS items_effective_reminder_idx ON items(effective_reminder);
    CREATE INDEX IF NOT EXISTS items_due_idx ON items(due);
    CREATE INDEX IF NOT EXISTS items_appt_date_idx ON items(appt_date);
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      text, people, tags, note,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    { value: string } | undefined;

  if (row && row.value === CURRENT_SCHEMA_VERSION) {
    createSchema(db);
    return;
  }

  // Schema version mismatch (or first run): drop the vault-derived tables
  // and recreate from scratch. meta itself is preserved (schema_version is
  // rewritten below); everything else is rebuilt from the vault later.
  db.exec('DROP TABLE IF EXISTS items_fts');
  db.exec('DROP TABLE IF EXISTS items');
  db.exec('DROP TABLE IF EXISTS notes');
  createSchema(db);
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', CURRENT_SCHEMA_VERSION);
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

async function walkMarkdownFiles(vaultDir: string): Promise<string[]> {
  const results: string[] = [];

  async function recurse(relDir: string): Promise<void> {
    const absDir = relDir ? `${vaultDir}/${relDir}` : vaultDir;
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await recurse(rel);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(rel);
      }
    }
  }

  await recurse('');
  return results;
}

/** Vault-relative .md paths that should be indexed: not ignored, not a conflict copy whose base exists. */
function filterIndexable(allFiles: string[]): string[] {
  const set = new Set(allFiles);
  return allFiles.filter((p) => {
    if (isIgnoredPath(p)) return false;
    const base = conflictCopyBase(p);
    if (base !== null && set.has(base)) return false;
    return true;
  });
}

function computeEffectiveReminder(reminder: string | null, snooze: string | null): string | null {
  if (reminder === null && snooze === null) return null;
  if (snooze === null) return reminder;
  if (reminder === null) return snooze;
  return snooze > reminder ? snooze : reminder;
}

function extractTokens(query: string): string[] {
  return query.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function clampLimit(limit: number | undefined): number {
  const n = limit ?? 10;
  return Math.min(Math.max(Math.trunc(n), 1), 50);
}

export function openIndex(opts: { dbPath: string; vaultDir: string; now?: () => Date }): Index {
  const now = opts.now ?? (() => new Date());
  const vaultDir = opts.vaultDir;
  const isMemory = opts.dbPath === ':memory:';

  if (!isMemory) {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
  }

  const db = new DatabaseSync(opts.dbPath);
  if (!isMemory) {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);

  function setMeta(key: string, value: string): void {
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  function getMeta(key: string): string | null {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row ? row.value : null;
  }

  function buildPeopleMap(): Map<string, string> {
    const rows = db.prepare("SELECT path FROM notes WHERE path LIKE 'People/%'").all() as {
      path: string;
    }[];
    const map = new Map<string, string>();
    for (const row of rows) {
      const rest = row.path.slice('People/'.length);
      if (rest.includes('/')) continue;
      const name = noteBasename(row.path);
      map.set(name.toLowerCase(), name);
    }
    return map;
  }

  function rowToIndexedItem(row: ItemRow, peopleMap: Map<string, string>): IndexedItem {
    const rawPeople = JSON.parse(row.people_json) as string[];
    const links = JSON.parse(row.links_json) as string[];
    const peopleSet = new Set(rawPeople);
    for (const link of links) {
      const canonical = peopleMap.get(link.toLowerCase());
      if (canonical) peopleSet.add(canonical);
    }

    return {
      id: row.id,
      kind: row.kind,
      path: row.path,
      lineNo: row.line_no,
      status: row.status,
      statusChar: row.status_char,
      text: row.text,
      raw: row.raw,
      reminder: row.reminder,
      snooze: row.snooze,
      appointment:
        row.appt_date !== null
          ? { date: row.appt_date, start: row.appt_start ?? '', end: row.appt_end }
          : null,
      due: row.due,
      created: row.created,
      done: row.done,
      cancelled: row.cancelled,
      repeat: row.repeat,
      expires: row.expires,
      keywords: JSON.parse(row.keywords_json) as string[],
      tags: JSON.parse(row.tags_json) as string[],
      links,
      people: [...peopleSet],
      direction: row.direction,
      effectiveReminder: row.effective_reminder,
      noteTitle: noteBasename(row.path),
    };
  }

  function deleteItemsForPath(relPath: string): void {
    const rows = db.prepare('SELECT rowid FROM items WHERE path = ?').all(relPath) as {
      rowid: number;
    }[];
    const del = db.prepare('DELETE FROM items_fts WHERE rowid = ?');
    for (const row of rows) del.run(row.rowid);
    db.prepare('DELETE FROM items WHERE path = ?').run(relPath);
  }

  function indexText(relPath: string, text: string, mtimeMs: number): void {
    const note = parseNote(text);
    const marker = note.frontmatter?.claudia ?? null;
    const size = Buffer.byteLength(text, 'utf8');

    deleteItemsForPath(relPath);

    db.prepare(
      `INSERT INTO notes (path, mtime_ms, size, marker)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, marker = excluded.marker`,
    ).run(relPath, mtimeMs, size, marker);

    const items = extractItems(relPath, note);
    const insertItem = db.prepare(
      `INSERT INTO items (
        id, path, line_no, kind, status, status_char, text, raw, reminder, snooze, effective_reminder,
        appt_date, appt_start, appt_end, due, created, done, cancelled, repeat, expires,
        keywords_json, tags_json, links_json, people_json, direction
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertFts = db.prepare(
      'INSERT INTO items_fts (rowid, text, people, tags, note) VALUES (?, ?, ?, ?, ?)',
    );

    const noteTitle = noteBasename(relPath);

    for (const item of items) {
      const effectiveReminder = computeEffectiveReminder(item.reminder, item.snooze);
      const result = insertItem.run(
        item.id,
        item.path,
        item.lineNo,
        item.kind,
        item.status,
        item.statusChar,
        item.text,
        item.raw,
        item.reminder,
        item.snooze,
        effectiveReminder,
        item.appointment?.date ?? null,
        item.appointment?.start ?? null,
        item.appointment?.end ?? null,
        item.due,
        item.created,
        item.done,
        item.cancelled,
        item.repeat,
        item.expires,
        JSON.stringify(item.keywords),
        JSON.stringify(item.tags),
        JSON.stringify(item.links),
        JSON.stringify(item.people),
        item.direction,
      );
      const rowid = result.lastInsertRowid;
      const ftsPeople = [...item.people, ...item.links].join(' ');
      insertFts.run(rowid, item.text, ftsPeople, item.tags.join(' '), noteTitle);
    }

    if (relPath === LAYOUT.settings) {
      setMeta('settings_cache', JSON.stringify(parseSettings(text)));
    }
  }

  function removeFile(relPath: string): void {
    deleteItemsForPath(relPath);
    db.prepare('DELETE FROM notes WHERE path = ?').run(relPath);
    if (relPath === LAYOUT.settings) {
      db.prepare("DELETE FROM meta WHERE key = 'settings_cache'").run();
    }
  }

  async function shouldIndex(relPath: string): Promise<boolean> {
    if (isIgnoredPath(relPath)) return false;
    const base = conflictCopyBase(relPath);
    if (base !== null && (await fileExists(`${vaultDir}/${base}`))) return false;
    return true;
  }

  async function reindexFile(relPath: string): Promise<void> {
    const abs = `${vaultDir}/${relPath}`;
    let fileStat;
    try {
      fileStat = await stat(abs);
    } catch (error) {
      if (isEnoent(error)) {
        removeFile(relPath);
        return;
      }
      throw error;
    }

    if (!fileStat.isFile() || !relPath.endsWith('.md') || !(await shouldIndex(relPath))) {
      removeFile(relPath);
      return;
    }

    const text = await readFile(abs, 'utf8');
    indexText(relPath, text, fileStat.mtimeMs);
  }

  async function rebuild(): Promise<{ notes: number; items: number; ms: number }> {
    const start = Date.now();

    db.exec('DELETE FROM items_fts');
    db.exec('DELETE FROM items');
    db.exec('DELETE FROM notes');
    db.exec("DELETE FROM meta WHERE key = 'settings_cache'");

    const allFiles = await walkMarkdownFiles(vaultDir);
    const toIndex = filterIndexable(allFiles);

    for (const relPath of toIndex) {
      const abs = `${vaultDir}/${relPath}`;
      const fileStat = await stat(abs);
      const text = await readFile(abs, 'utf8');
      indexText(relPath, text, fileStat.mtimeMs);
    }

    const notesCount = (db.prepare('SELECT COUNT(*) as n FROM notes').get() as { n: number }).n;
    const itemsCount = (db.prepare('SELECT COUNT(*) as n FROM items').get() as { n: number }).n;
    const ms = Date.now() - start;
    setMeta('lastRebuild', now().toISOString());

    return { notes: notesCount, items: itemsCount, ms };
  }

  async function refresh(): Promise<string[]> {
    const allFiles = await walkMarkdownFiles(vaultDir);
    const toKeep = filterIndexable(allFiles);
    const diskSet = new Set(toKeep);

    const changed: string[] = [];

    const dbRows = db.prepare('SELECT path, mtime_ms, size FROM notes').all() as {
      path: string;
      mtime_ms: number;
      size: number;
    }[];
    const dbMap = new Map(dbRows.map((r) => [r.path, r]));

    for (const row of dbRows) {
      if (!diskSet.has(row.path)) {
        removeFile(row.path);
        changed.push(row.path);
      }
    }

    for (const relPath of toKeep) {
      const abs = `${vaultDir}/${relPath}`;
      const fileStat = await stat(abs);
      const existing = dbMap.get(relPath);
      if (existing && existing.mtime_ms === fileStat.mtimeMs && existing.size === fileStat.size) {
        continue;
      }
      const text = await readFile(abs, 'utf8');
      indexText(relPath, text, fileStat.mtimeMs);
      changed.push(relPath);
    }

    return changed;
  }

  function getItem(id: string): IndexedItem | null {
    const rows = db
      .prepare(
        `SELECT items.*, notes.mtime_ms as note_mtime
         FROM items JOIN notes ON notes.path = items.path
         WHERE items.id = ?`,
      )
      .all(id) as unknown as (ItemRow & { note_mtime: number })[];

    if (rows.length === 0) return null;

    rows.sort((a, b) => {
      const openA = a.status === 'open' ? 0 : 1;
      const openB = b.status === 'open' ? 0 : 1;
      if (openA !== openB) return openA - openB;
      return b.note_mtime - a.note_mtime;
    });

    const first = rows[0];
    if (!first) return null;
    return rowToIndexedItem(first, buildPeopleMap());
  }

  function hasId(id: string): boolean {
    const row = db.prepare('SELECT 1 FROM items WHERE id = ? LIMIT 1').get(id);
    return row !== undefined;
  }

  function itemsInNote(relPath: string): IndexedItem[] {
    const rows = db
      .prepare('SELECT * FROM items WHERE path = ? ORDER BY line_no')
      .all(relPath) as unknown as ItemRow[];
    const peopleMap = buildPeopleMap();
    return rows.map((r) => rowToIndexedItem(r, peopleMap));
  }

  function runFtsQuery(expr: string): ItemRow[] {
    return db
      .prepare(
        `SELECT items.* FROM items_fts
         JOIN items ON items.rowid = items_fts.rowid
         WHERE items_fts MATCH ?
         ORDER BY bm25(items_fts) ASC, items.path ASC, items.line_no ASC`,
      )
      .all(expr) as unknown as ItemRow[];
  }

  function matchesQuery(item: IndexedItem, q: SearchQuery): boolean {
    if (q.kinds && q.kinds.length > 0 && !q.kinds.includes(item.kind)) return false;
    const alwaysOpen = item.kind === 'fact' || item.kind === 'rule';
    if (!q.includeDone && !alwaysOpen && item.status !== 'open') return false;
    if (q.person) {
      const target = q.person.toLowerCase();
      if (!item.people.some((p) => p.toLowerCase() === target)) return false;
    }
    return true;
  }

  function search(q: SearchQuery): { total: number; results: IndexedItem[] } {
    const limit = clampLimit(q.limit);
    const tokens = extractTokens(q.query);
    const peopleMap = buildPeopleMap();

    let rows: ItemRow[];
    if (tokens.length === 0) {
      rows = db
        .prepare('SELECT * FROM items ORDER BY path ASC, line_no ASC')
        .all() as unknown as ItemRow[];
    } else {
      const andExpr = tokens.map((t) => `"${t}"*`).join(' AND ');
      rows = runFtsQuery(andExpr);
      if (rows.length === 0) {
        const orExpr = tokens.map((t) => `"${t}"*`).join(' OR ');
        rows = runFtsQuery(orExpr);
      }
    }

    const items = rows
      .map((r) => rowToIndexedItem(r, peopleMap))
      .filter((item) => matchesQuery(item, q));

    return { total: items.length, results: items.slice(0, limit) };
  }

  function openReminders(range?: { from?: string; to?: string }): IndexedItem[] {
    const peopleMap = buildPeopleMap();
    const clauses = [
      "kind IN ('task','follow_up')",
      "status = 'open'",
      'effective_reminder IS NOT NULL',
    ];
    const params: string[] = [];
    if (range?.from) {
      clauses.push('effective_reminder >= ?');
      params.push(range.from);
    }
    if (range?.to) {
      clauses.push('effective_reminder <= ?');
      params.push(range.to);
    }
    const sql = `SELECT * FROM items WHERE ${clauses.join(' AND ')} ORDER BY effective_reminder ASC, path ASC, line_no ASC`;
    const rows = db.prepare(sql).all(...params) as unknown as ItemRow[];
    return rows.map((r) => rowToIndexedItem(r, peopleMap));
  }

  function openDue(range: { from?: string; to?: string }): IndexedItem[] {
    const peopleMap = buildPeopleMap();
    const clauses = ["kind IN ('task','follow_up')", "status = 'open'", 'due IS NOT NULL'];
    const params: string[] = [];
    if (range.from) {
      clauses.push('due >= ?');
      params.push(range.from);
    }
    if (range.to) {
      clauses.push('due <= ?');
      params.push(range.to);
    }
    const sql = `SELECT * FROM items WHERE ${clauses.join(' AND ')} ORDER BY due ASC, path ASC, line_no ASC`;
    const rows = db.prepare(sql).all(...params) as unknown as ItemRow[];
    return rows.map((r) => rowToIndexedItem(r, peopleMap));
  }

  function appointments(range: { from: string; to: string; includeDone?: boolean }): IndexedItem[] {
    const peopleMap = buildPeopleMap();
    const clauses = ["kind = 'appointment'", 'appt_date >= ?', 'appt_date <= ?'];
    const params: string[] = [range.from, range.to];
    if (!range.includeDone) clauses.push("status = 'open'");
    const sql = `SELECT * FROM items WHERE ${clauses.join(' AND ')} ORDER BY appt_date ASC, appt_start ASC`;
    const rows = db.prepare(sql).all(...params) as unknown as ItemRow[];
    return rows.map((r) => rowToIndexedItem(r, peopleMap));
  }

  function followUps(fuOpts?: { includeDone?: boolean }): IndexedItem[] {
    const peopleMap = buildPeopleMap();
    const clauses = ["kind = 'follow_up'"];
    if (!fuOpts?.includeDone) clauses.push("status = 'open'");
    const sql = `SELECT * FROM items WHERE ${clauses.join(' AND ')} ORDER BY path ASC, line_no ASC`;
    const rows = db.prepare(sql).all() as unknown as ItemRow[];
    return rows.map((r) => rowToIndexedItem(r, peopleMap));
  }

  function facts(factOpts?: { person?: string }): IndexedItem[] {
    const peopleMap = buildPeopleMap();
    const rows = db
      .prepare("SELECT * FROM items WHERE kind = 'fact' ORDER BY path ASC, line_no ASC")
      .all() as unknown as ItemRow[];
    let items = rows.map((r) => rowToIndexedItem(r, peopleMap));
    if (factOpts?.person) {
      const target = factOpts.person.toLowerCase();
      items = items.filter((i) => i.people.some((p) => p.toLowerCase() === target));
    }
    return items;
  }

  function staleFacts(today: string): IndexedItem[] {
    const peopleMap = buildPeopleMap();
    const rows = db
      .prepare(
        "SELECT * FROM items WHERE kind = 'fact' AND expires IS NOT NULL AND expires < ? ORDER BY expires ASC",
      )
      .all(today) as unknown as ItemRow[];
    return rows.map((r) => rowToIndexedItem(r, peopleMap));
  }

  function rules(): Rule[] {
    const rows = db
      .prepare(
        "SELECT id, text, keywords_json FROM items WHERE kind = 'rule' ORDER BY path ASC, line_no ASC",
      )
      .all() as { id: string | null; text: string; keywords_json: string }[];
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      keywords: JSON.parse(r.keywords_json) as string[],
    }));
  }

  function settings(): { settings: Settings; warnings: string[] } {
    const raw = getMeta('settings_cache');
    if (!raw) return { settings: { ...DEFAULT_SETTINGS }, warnings: [] };
    return JSON.parse(raw) as { settings: Settings; warnings: string[] };
  }

  function people(): string[] {
    return [...buildPeopleMap().values()].sort((a, b) => a.localeCompare(b));
  }

  function duplicateIds(): string[] {
    const rows = db
      .prepare(
        'SELECT id FROM items WHERE id IS NOT NULL GROUP BY id HAVING COUNT(*) > 1 ORDER BY id',
      )
      .all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  function notePaths(): string[] {
    const rows = db.prepare('SELECT path FROM notes ORDER BY path').all() as { path: string }[];
    return rows.map((r) => r.path);
  }

  function stats(): { notes: number; items: number; lastRebuild: string | null } {
    const notesCount = (db.prepare('SELECT COUNT(*) as n FROM notes').get() as { n: number }).n;
    const itemsCount = (db.prepare('SELECT COUNT(*) as n FROM items').get() as { n: number }).n;
    return { notes: notesCount, items: itemsCount, lastRebuild: getMeta('lastRebuild') };
  }

  function close(): void {
    db.close();
  }

  return {
    rebuild,
    refresh,
    reindexFile,
    indexText,
    removeFile,
    getItem,
    hasId,
    itemsInNote,
    search,
    openReminders,
    openDue,
    appointments,
    followUps,
    facts,
    staleFacts,
    rules,
    settings,
    people,
    duplicateIds,
    notePaths,
    stats,
    close,
  };
}
