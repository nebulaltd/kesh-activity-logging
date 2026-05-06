import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../src/db/client';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate';

describe('migrations', () => {
  it('creates the logs schema on a fresh DB', () => {
    const db = new Database(':memory:');
    const applied = runMigrations(db, MIGRATIONS_DIR);
    expect(applied).toEqual(['0001_init.sql', '0002_activity_fields.sql']);

    const cols = db
      .query<{ name: string }, []>('PRAGMA table_info(logs)')
      .all()
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual([
      'action',
      'client_id',
      'context',
      'entity_id',
      'entity_type',
      'id',
      'level',
      'message',
      'received_at',
      'source',
      'timestamp',
      'trace_id',
      'user_id',
    ]);

    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='logs' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((i) => i.name)
      .sort();
    expect(indexes).toEqual([
      'idx_logs_action_timestamp',
      'idx_logs_client_timestamp',
      'idx_logs_entity',
      'idx_logs_level_timestamp',
      'idx_logs_source_timestamp',
      'idx_logs_timestamp',
      'idx_logs_trace_id',
    ]);
  });

  it('rerunning is a no-op', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const second = runMigrations(db, MIGRATIONS_DIR);
    expect(second).toEqual([]);
  });

  it('enforces level CHECK constraint', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    expect(() =>
      db
        .prepare(
          'INSERT INTO logs (id, timestamp, source, level, message, received_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('id1', Date.now(), 'svc', 'bogus', 'msg', Date.now()),
    ).toThrow();
  });

  it('applies expected pragmas on a file DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kesh-mig-'));
    try {
      const db = createDb(join(dir, 'test.db'));
      const journal = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
      expect(journal?.journal_mode).toBe('wal');

      const sync = db.query<{ synchronous: number }, []>('PRAGMA synchronous').get();
      expect(sync?.synchronous).toBe(1);

      const fk = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
      expect(fk?.foreign_keys).toBe(1);

      const timeout = db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get();
      expect(timeout?.timeout).toBe(5000);

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
