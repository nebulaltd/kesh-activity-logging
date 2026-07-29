import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { loadConfig, type Config } from '../src/config';
import { runMigrations } from '../src/db/migrate';
import { startLogPuller, type PullRunResult } from '../src/logs/poller';
import {
  assertOneshotMode,
  recordFailureHeartbeat,
  recordRunHeartbeat,
} from '../src/logs/pull-once';

function buildDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function buildConfig(mode: string): Config {
  return loadConfig({
    API_KEY: 'local-key',
    LOG_PULL_MODE: mode,
    LOG_PULL_SOURCE_URL: 'https://kesh-back.example/internal/activity-logs',
    LOG_PULL_API_KEY: 'pull-key',
  });
}

function buildResult(overrides: Partial<PullRunResult> = {}): PullRunResult {
  return {
    sources: [
      {
        name: 'aws-live',
        fetched: 3,
        inserted: 3,
        duplicates: 0,
        batches: 1,
        hitIterationCap: false,
      },
    ],
    fetched: 3,
    inserted: 3,
    duplicates: 0,
    hitIterationCap: false,
    durationMs: 12,
    ...overrides,
  };
}

describe('assertOneshotMode', () => {
  test('accepts oneshot', () => {
    expect(() => assertOneshotMode(buildConfig('oneshot'))).not.toThrow();
  });

  test('refuses to run the cron pull when the instance owns an interval poller', () => {
    expect(() => assertOneshotMode(buildConfig('interval'))).toThrow(
      'LOG_PULL_MODE must be "oneshot"',
    );
  });

  test('refuses to run when pulling is disabled', () => {
    expect(() => assertOneshotMode(buildConfig('off'))).toThrow('LOG_PULL_MODE must be "oneshot"');
  });
});

describe('startLogPuller mode gate', () => {
  test('does not poll when a source is configured but mode is oneshot', () => {
    const db = buildDb();
    let fetches = 0;
    const fetchFn = async () => {
      fetches += 1;
      return new Response('{"items":[]}', { headers: { 'content-type': 'application/json' } });
    };

    const stop = startLogPuller({ db, config: buildConfig('oneshot'), fetchFn });
    stop();

    expect(fetches).toBe(0);
    db.close();
  });

  test('polls when mode is interval', () => {
    const db = buildDb();
    let fetches = 0;
    const fetchFn = async () => {
      fetches += 1;
      return new Response('{"items":[]}', { headers: { 'content-type': 'application/json' } });
    };

    const stop = startLogPuller({ db, config: buildConfig('interval'), fetchFn });
    stop();

    expect(fetches).toBe(1);
    db.close();
  });
});

describe('run heartbeat', () => {
  test('records a queryable summary row', () => {
    const db = buildDb();

    recordRunHeartbeat(db, buildResult(), () => 1780417005000);

    const row = db
      .query<
        { source: string; level: string; action: string; message: string; context: string },
        []
      >('SELECT source, level, action, message, context FROM logs')
      .get();

    expect(row?.source).toBe('activity-log-puller');
    expect(row?.level).toBe('info');
    expect(row?.action).toBe('pull_run');
    expect(row?.message).toBe('Pulled 3 activity logs from 1 source(s)');
    expect(JSON.parse(row?.context ?? '{}')).toMatchObject({
      inserted: 3,
      hit_iteration_cap: false,
      duration_ms: 12,
    });
    db.close();
  });

  test('warns when the run hit the iteration cap', () => {
    const db = buildDb();

    recordRunHeartbeat(db, buildResult({ hitIterationCap: true }), () => 1780417005000);

    const row = db.query<{ level: string }, []>('SELECT level FROM logs').get();

    expect(row?.level).toBe('warn');
    db.close();
  });

  test('records failures locally so a dead tunnel is still visible', () => {
    const db = buildDb();

    recordFailureHeartbeat(db, new Error('tunnel down'), () => 1780417005000);

    const row = db
      .query<
        { level: string; action: string; message: string },
        []
      >('SELECT level, action, message FROM logs')
      .get();

    expect(row?.level).toBe('error');
    expect(row?.action).toBe('pull_run_failed');
    expect(row?.message).toBe('Activity log pull failed: tunnel down');
    db.close();
  });
});
