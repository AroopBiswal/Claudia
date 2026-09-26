import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

describe('node:sqlite smoke test', () => {
  it('creates an fts5 virtual table, inserts a row and matches it', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE notes USING fts5(body)');
      db.exec("INSERT INTO notes(body) VALUES ('capture the reminder tomorrow')");

      const rows = db.prepare('SELECT body FROM notes WHERE notes MATCH ?').all('reminder');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ body: 'capture the reminder tomorrow' });
    } finally {
      db.close();
    }
  });
});
