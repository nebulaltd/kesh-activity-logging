import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database } from 'bun:sqlite';
import { loadConfig, type Config } from '../config';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { newId } from '../lib/id';
import { insertLog } from './repository';
import { pullLogsOnce, type PullRunResult } from './poller';

const HEARTBEAT_SOURCE = 'activity-log-puller';
const HEARTBEAT_PING_TIMEOUT_MS = 5_000;

export function recordRunHeartbeat(
  db: Database,
  result: PullRunResult,
  now: () => number = Date.now,
): void {
  const timestamp = now();

  insertLog(db, {
    id: newId(),
    timestamp,
    source: HEARTBEAT_SOURCE,
    level: result.hitIterationCap ? 'warn' : 'info',
    message: `Pulled ${result.inserted} activity logs from ${result.sources.length} source(s)`,
    context: JSON.stringify({
      sources: result.sources,
      fetched: result.fetched,
      inserted: result.inserted,
      duplicates: result.duplicates,
      hit_iteration_cap: result.hitIterationCap,
      duration_ms: result.durationMs,
    }),
    trace_id: null,
    user_id: null,
    entity_type: null,
    entity_id: null,
    action: 'pull_run',
    client_id: null,
    received_at: timestamp,
    remote_source: null,
    remote_id: null,
  });
}

export function recordFailureHeartbeat(
  db: Database,
  error: unknown,
  now: () => number = Date.now,
): void {
  const timestamp = now();

  insertLog(db, {
    id: newId(),
    timestamp,
    source: HEARTBEAT_SOURCE,
    level: 'error',
    message: `Activity log pull failed: ${errorMessage(error)}`,
    context: null,
    trace_id: null,
    user_id: null,
    entity_type: null,
    entity_id: null,
    action: 'pull_run_failed',
    client_id: null,
    received_at: timestamp,
    remote_source: null,
    remote_id: null,
  });
}

export function assertOneshotMode(config: Config): void {
  if (config.LOG_PULL_MODE !== 'oneshot') {
    throw new Error(
      `LOG_PULL_MODE must be "oneshot" to run a scheduled pull, got "${config.LOG_PULL_MODE}"`,
    );
  }
}

async function pingHeartbeat(config: Config): Promise<void> {
  if (!config.LOG_PULL_HEARTBEAT_URL) return;

  try {
    await fetch(config.LOG_PULL_HEARTBEAT_URL, {
      signal: AbortSignal.timeout(HEARTBEAT_PING_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`heartbeat ping failed: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  let config: Config;

  try {
    config = loadConfig();
    assertOneshotMode(config);
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }

  if (config.DATABASE_PATH !== ':memory:') {
    mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
  }

  const db = createDb(config.DATABASE_PATH);
  runMigrations(db);

  try {
    const result = await pullLogsOnce({ db, config });
    recordRunHeartbeat(db, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);

    if (result.hitIterationCap) {
      console.error('pull hit LOG_PULL_MAX_ITERATIONS; source outbox is falling behind');
    }

    await pingHeartbeat(config);
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    try {
      recordFailureHeartbeat(db, error);
    } catch (heartbeatError) {
      console.error(`failed to record failure heartbeat: ${errorMessage(heartbeatError)}`);
    }
    return 1;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(await main());
}
