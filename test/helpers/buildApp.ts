import { Database } from 'bun:sqlite';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config';
import { runMigrations } from '../../src/db/migrate';
import { buildApp } from '../../src/server';

export interface TestApp {
  app: FastifyInstance;
  db: Database;
  apiKey: string;
}

export function buildTestApp(overrides?: Partial<Config>): TestApp {
  const apiKey = overrides?.API_KEY ?? 'test-key';
  const config: Config = {
    PORT: 0,
    HOST: '127.0.0.1',
    DATABASE_PATH: ':memory:',
    LOG_LEVEL: 'fatal',
    BODY_LIMIT_BYTES: 1_048_576,
    ...overrides,
    API_KEY: apiKey,
  };
  const db = new Database(':memory:');
  runMigrations(db);
  const app = buildApp({ db, config });
  return { app, db, apiKey };
}
