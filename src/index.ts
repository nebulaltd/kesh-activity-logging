import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { buildApp } from './server';

const config = loadConfig();

if (config.DATABASE_PATH !== ':memory:') {
  mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
}

const db = createDb(config.DATABASE_PATH);
runMigrations(db);

const app = buildApp({ db, config });

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
