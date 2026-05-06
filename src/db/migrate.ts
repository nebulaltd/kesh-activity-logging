import type { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDb } from './client';

export const MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

export function runMigrations(db: Database, migrationsDir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(
    db.query<{ id: string }, []>('SELECT id FROM _migrations').all().map((r) => r.id),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const insert = db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)');
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      insert.run(file, Date.now());
    });
    tx();
    newlyApplied.push(file);
  }
  return newlyApplied;
}

if (import.meta.main) {
  const path = process.env.DATABASE_PATH ?? './data/logs.db';
  mkdirSync(dirname(path), { recursive: true });
  const db = createDb(path);
  const applied = runMigrations(db);
  if (applied.length === 0) {
    console.error('No new migrations.');
  } else {
    console.error(`Applied: ${applied.join(', ')}`);
  }
  db.close();
}
