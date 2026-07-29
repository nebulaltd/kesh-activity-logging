import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { loadConfig, type Config, type LogPullSource } from '../src/config';
import { runMigrations } from '../src/db/migrate';
import { fetchRemoteLogs, pullLogsOnce } from '../src/logs/poller';

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    API_KEY: 'local-key',
    LOG_PULL_SOURCE_URL: 'https://kesh-back.example/internal/activity-logs',
    LOG_PULL_API_KEY: 'pull-key',
    ...env,
  });
}

function firstSource(config: Config): LogPullSource {
  const source = config.LOG_PULL_SOURCES[0];
  if (!source) throw new Error('expected a configured pull source');
  return source;
}

function buildDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('fetchRemoteLogs', () => {
  test('sends the internal api key header and requested batch size', async () => {
    const calls: FetchCall[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ items: [] });
    };

    const config = buildConfig();
    await fetchRemoteLogs(firstSource(config), config.LOG_PULL_BATCH_SIZE, fetchFn);

    expect(calls[0]?.url).toBe('https://kesh-back.example/internal/activity-logs?limit=500');
    expect(calls[0]?.init?.headers).toEqual({ 'x-internal-api-key': 'pull-key' });
  });

  test('rejects invalid remote payloads before insertion', async () => {
    const fetchFn = async () => jsonResponse({ items: [{ id: 'remote-1', source: 'kesh-back' }] });

    const config = buildConfig();
    await expect(
      fetchRemoteLogs(firstSource(config), config.LOG_PULL_BATCH_SIZE, fetchFn),
    ).rejects.toThrow();
  });
});

describe('pullLogsOnce', () => {
  test('inserts fetched logs and acknowledges only inserted remote ids', async () => {
    const db = buildDb();
    const calls: FetchCall[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/ack')) return jsonResponse({ acknowledged: 1 });
      return jsonResponse({
        items: [
          {
            id: 'remote-1',
            timestamp: 1780417000000,
            source: 'kesh-back',
            level: 'info',
            message: 'User login succeeded',
            context: { email: 'user@example.com' },
            user_id: '42',
            entity_type: 'User',
            entity_id: '42',
            action: 'login',
            client_id: null,
            trace_id: null,
          },
        ],
      });
    };

    await pullLogsOnce({ db, config: buildConfig(), fetchFn, now: () => 1780417001000 });

    const row = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM logs').get();
    expect(row?.count).toBe(1);
    expect(calls[1]?.url).toBe('https://kesh-back.example/internal/activity-logs/ack');
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ ids: ['remote-1'] }));
    db.close();
  });

  test('acks duplicate remote ids without storing duplicate rows', async () => {
    const db = buildDb();
    const fetchFn = async (url: string | URL | Request) => {
      if (String(url).endsWith('/ack')) return jsonResponse({ acknowledged: 1 });
      return jsonResponse({
        items: [
          {
            id: 'remote-1',
            timestamp: 1780417000000,
            source: 'kesh-back',
            level: 'info',
            message: 'duplicate-safe event',
            context: null,
            user_id: null,
            entity_type: null,
            entity_id: null,
            action: null,
            client_id: null,
            trace_id: null,
          },
        ],
      });
    };

    await pullLogsOnce({ db, config: buildConfig(), fetchFn, now: () => 1780417001000 });
    await pullLogsOnce({ db, config: buildConfig(), fetchFn, now: () => 1780417002000 });

    const row = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM logs').get();
    expect(row?.count).toBe(1);
    db.close();
  });

  test('does not acknowledge when fetch fails', async () => {
    const db = buildDb();
    const calls: FetchCall[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      throw new Error('network failed');
    };

    await expect(pullLogsOnce({ db, config: buildConfig(), fetchFn })).rejects.toThrow(
      'network failed',
    );

    expect(calls).toHaveLength(1);
    db.close();
  });
});

function makeRemote(id: string) {
  return {
    id,
    timestamp: 1780417000000,
    source: 'kesh-back',
    level: 'info',
    message: `event ${id}`,
    context: null,
    user_id: null,
    entity_type: null,
    entity_id: null,
    action: null,
    client_id: null,
    trace_id: null,
  };
}

describe('pullLogsOnce drain loop', () => {
  test('keeps pulling full batches and stops at the iteration cap', async () => {
    const db = buildDb();
    let batch = 0;
    const fetchFn = async (url: string | URL | Request) => {
      if (String(url).endsWith('/ack')) return jsonResponse({ acknowledged: 2 });
      batch += 1;
      return jsonResponse({ items: [makeRemote(`b${batch}-1`), makeRemote(`b${batch}-2`)] });
    };

    const result = await pullLogsOnce({
      db,
      config: buildConfig({ LOG_PULL_BATCH_SIZE: '2', LOG_PULL_MAX_ITERATIONS: '3' }),
      fetchFn,
      now: () => 1780417001000,
    });

    expect(result.sources[0]?.batches).toBe(3);
    expect(result.inserted).toBe(6);
    expect(result.hitIterationCap).toBe(true);
    db.close();
  });

  test('stops as soon as a partial batch arrives', async () => {
    const db = buildDb();
    let fetches = 0;
    const fetchFn = async (url: string | URL | Request) => {
      if (String(url).endsWith('/ack')) return jsonResponse({ acknowledged: 1 });
      fetches += 1;
      return jsonResponse({ items: [makeRemote('only-one')] });
    };

    const result = await pullLogsOnce({
      db,
      config: buildConfig({ LOG_PULL_BATCH_SIZE: '2', LOG_PULL_MAX_ITERATIONS: '5' }),
      fetchFn,
      now: () => 1780417001000,
    });

    expect(fetches).toBe(1);
    expect(result.hitIterationCap).toBe(false);
    db.close();
  });

  test('stores the configured source name as remote_source', async () => {
    const db = buildDb();
    const fetchFn = async (url: string | URL | Request) => {
      if (String(url).endsWith('/ack')) return jsonResponse({ acknowledged: 1 });
      return jsonResponse({ items: [makeRemote('remote-1')] });
    };

    await pullLogsOnce({
      db,
      config: buildConfig({
        LOG_PULL_SOURCE_1_NAME: 'aws-live',
        LOG_PULL_SOURCE_1_URL: 'https://live.example/internal/activity-logs',
        LOG_PULL_SOURCE_1_API_KEY: 'live-key',
      }),
      fetchFn,
      now: () => 1780417001000,
    });

    const row = db.query<{ remote_source: string }, []>('SELECT remote_source FROM logs').get();
    expect(row?.remote_source).toBe('aws-live');
    db.close();
  });

  test('drains every configured source and reports per-source counts', async () => {
    const db = buildDb();
    const fetchFn = async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith('/ack')) return jsonResponse({ acknowledged: 1 });
      if (target.startsWith('https://live.example'))
        return jsonResponse({ items: [makeRemote('live-1')] });
      return jsonResponse({ items: [makeRemote('onprem-1')] });
    };

    const result = await pullLogsOnce({
      db,
      config: buildConfig({
        LOG_PULL_SOURCE_1_NAME: 'aws-live',
        LOG_PULL_SOURCE_1_URL: 'https://live.example/internal/activity-logs',
        LOG_PULL_SOURCE_1_API_KEY: 'live-key',
        LOG_PULL_SOURCE_2_NAME: 'onprem',
        LOG_PULL_SOURCE_2_URL: 'https://onprem.example/internal/activity-logs',
        LOG_PULL_SOURCE_2_API_KEY: 'onprem-key',
      }),
      fetchFn,
      now: () => 1780417001000,
    });

    expect(result.sources.map((source) => source.name)).toEqual(['aws-live', 'onprem']);
    expect(result.inserted).toBe(2);
    db.close();
  });

  test('drains healthy sources before surfacing a failing one', async () => {
    const db = buildDb();
    const fetchFn = async (url: string | URL | Request) => {
      const target = String(url);
      if (target.startsWith('https://live.example')) throw new Error('tunnel down');
      if (target.endsWith('/ack')) return jsonResponse({ acknowledged: 1 });
      return jsonResponse({ items: [makeRemote('onprem-1')] });
    };

    const config = buildConfig({
      LOG_PULL_SOURCE_1_NAME: 'aws-live',
      LOG_PULL_SOURCE_1_URL: 'https://live.example/internal/activity-logs',
      LOG_PULL_SOURCE_1_API_KEY: 'live-key',
      LOG_PULL_SOURCE_2_NAME: 'onprem',
      LOG_PULL_SOURCE_2_URL: 'https://onprem.example/internal/activity-logs',
      LOG_PULL_SOURCE_2_API_KEY: 'onprem-key',
    });

    await expect(pullLogsOnce({ db, config, fetchFn, now: () => 1780417001000 })).rejects.toThrow(
      'tunnel down',
    );

    const row = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM logs').get();
    expect(row?.count).toBe(1);
    db.close();
  });
});
