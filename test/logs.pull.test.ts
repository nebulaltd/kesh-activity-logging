import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';
import { runMigrations } from '../src/db/migrate';
import { fetchRemoteLogs, pullLogsOnce } from '../src/logs/poller';

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildConfig() {
  return loadConfig({
    API_KEY: 'local-key',
    LOG_PULL_SOURCE_URL: 'https://kesh-back.example/internal/activity-logs',
    LOG_PULL_API_KEY: 'pull-key',
  });
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

    await fetchRemoteLogs(buildConfig(), fetchFn);

    expect(calls[0]?.url).toBe('https://kesh-back.example/internal/activity-logs?limit=500');
    expect(calls[0]?.init?.headers).toEqual({ 'x-internal-api-key': 'pull-key' });
  });

  test('rejects invalid remote payloads before insertion', async () => {
    const fetchFn = async () => jsonResponse({ items: [{ id: 'remote-1', source: 'kesh-back' }] });

    await expect(fetchRemoteLogs(buildConfig(), fetchFn)).rejects.toThrow();
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

    await expect(pullLogsOnce({ db, config: buildConfig(), fetchFn })).rejects.toThrow('network failed');

    expect(calls).toHaveLength(1);
    db.close();
  });
});
