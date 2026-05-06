import { Database } from 'bun:sqlite';

export function createDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
