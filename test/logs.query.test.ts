import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ulid } from 'ulid';
import { decodeCursor } from '../src/logs/cursor';
import { buildTestApp, type TestApp } from './helpers/buildApp';

interface LogItem {
  id: string;
  timestamp: number;
  source: string;
  level: string;
  message: string;
  context: Record<string, unknown> | null;
  trace_id: string | null;
  user_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  action: string | null;
  client_id: string | null;
  received_at: number;
}
interface QueryResponse {
  items: LogItem[];
  next_cursor: string | null;
}
interface ErrorBody {
  error: { code: string; message: string };
}

const SOURCES = ['api', 'worker', 'cron', 'auth', 'billing'] as const;
const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
const BASE_TS = 1_700_000_000_000;
const SEED_COUNT = 25;

interface Seeded {
  id: string;
  timestamp: number;
  source: string;
  level: string;
  message: string;
  trace_id: string | null;
}

function seed(ctx: TestApp): Seeded[] {
  const stmt = ctx.db.prepare(
    `INSERT INTO logs (id, timestamp, source, level, message, context, trace_id, user_id, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const seeded: Seeded[] = [];
  for (let i = 0; i < SEED_COUNT; i++) {
    const id = ulid();
    const ts = BASE_TS + i * 1000;
    const source = SOURCES[i % SOURCES.length]!;
    const level = LEVELS[i % LEVELS.length]!;
    const message = `event ${i} marker${i % 3}`;
    const trace_id = i < 10 ? 'trace-A' : i < 20 ? 'trace-B' : null;
    stmt.run(id, ts, source, level, message, null, trace_id, null, Date.now());
    seeded.push({ id, timestamp: ts, source, level, message, trace_id });
  }
  return seeded;
}

describe('GET /logs', () => {
  let ctx: TestApp;
  let seeded: Seeded[];

  beforeEach(async () => {
    ctx = buildTestApp({ API_KEY: 'k' });
    await ctx.app.ready();
    seeded = seed(ctx);
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.db.close();
  });

  function get(query: Record<string, string | number>) {
    const qs = new URLSearchParams(
      Object.entries(query).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
    return ctx.app.inject({
      method: 'GET',
      url: `/logs${qs ? `?${qs}` : ''}`,
      headers: { 'x-api-key': 'k' },
    });
  }

  it('returns all rows in descending timestamp order with no filters', async () => {
    const res = await get({});
    expect(res.statusCode).toBe(200);
    const body = res.json<QueryResponse>();
    expect(body.items).toHaveLength(SEED_COUNT);
    expect(body.next_cursor).toBeNull();
    for (let i = 1; i < body.items.length; i++) {
      expect(body.items[i - 1]!.timestamp).toBeGreaterThanOrEqual(body.items[i]!.timestamp);
    }
  });

  it('filters by source', async () => {
    const res = await get({ source: 'api' });
    const body = res.json<QueryResponse>();
    const expected = seeded.filter((r) => r.source === 'api').length;
    expect(body.items).toHaveLength(expected);
    body.items.forEach((it) => expect(it.source).toBe('api'));
  });

  it('filters by level', async () => {
    const res = await get({ level: 'error' });
    const body = res.json<QueryResponse>();
    const expected = seeded.filter((r) => r.level === 'error').length;
    expect(body.items).toHaveLength(expected);
    body.items.forEach((it) => expect(it.level).toBe('error'));
  });

  it('filters by from/to time window inclusive', async () => {
    const from = BASE_TS + 5000;
    const to = BASE_TS + 10_000;
    const res = await get({ from, to });
    const body = res.json<QueryResponse>();
    const expected = seeded.filter((r) => r.timestamp >= from && r.timestamp <= to).length;
    expect(body.items).toHaveLength(expected);
    body.items.forEach((it) => {
      expect(it.timestamp).toBeGreaterThanOrEqual(from);
      expect(it.timestamp).toBeLessThanOrEqual(to);
    });
  });

  it('filters by trace_id', async () => {
    const res = await get({ trace_id: 'trace-B' });
    const body = res.json<QueryResponse>();
    expect(body.items).toHaveLength(10);
    body.items.forEach((it) => expect(it.trace_id).toBe('trace-B'));
  });

  it('filters by q substring (literal, not LIKE wildcard)', async () => {
    const res = await get({ q: 'marker1' });
    const body = res.json<QueryResponse>();
    const expected = seeded.filter((r) => r.message.includes('marker1')).length;
    expect(body.items).toHaveLength(expected);
    body.items.forEach((it) => expect(it.message).toContain('marker1'));
  });

  it('treats q as a literal string (% does not act as wildcard)', async () => {
    const res = await get({ q: '%' });
    const body = res.json<QueryResponse>();
    expect(body.items).toHaveLength(0);
  });

  it('combines multiple filters with AND', async () => {
    const res = await get({ source: 'api', level: 'debug' });
    const body = res.json<QueryResponse>();
    const expected = seeded.filter((r) => r.source === 'api' && r.level === 'debug').length;
    expect(body.items).toHaveLength(expected);
  });

  it('walks all pages with limit=10 and emits no duplicates', async () => {
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    while (pages < 10) {
      const params: Record<string, string | number> = { limit: 10 };
      if (cursor) params.cursor = cursor;
      const res = await get(params);
      expect(res.statusCode).toBe(200);
      const body = res.json<QueryResponse>();
      collected.push(...body.items.map((i) => i.id));
      pages += 1;
      if (!body.next_cursor) break;
      cursor = body.next_cursor;
    }
    expect(pages).toBe(3);
    expect(collected).toHaveLength(SEED_COUNT);
    expect(new Set(collected).size).toBe(SEED_COUNT);
  });

  it('returns next_cursor=null exactly when results fit in a single page', async () => {
    const res = await get({ limit: SEED_COUNT });
    const body = res.json<QueryResponse>();
    expect(body.items).toHaveLength(SEED_COUNT);
    expect(body.next_cursor).toBeNull();

    const res2 = await get({ limit: SEED_COUNT - 1 });
    const body2 = res2.json<QueryResponse>();
    expect(body2.items).toHaveLength(SEED_COUNT - 1);
    expect(body2.next_cursor).not.toBeNull();
  });

  it('cursor stability: rows inserted after page 1 do not appear in subsequent pages', async () => {
    const page1 = (await get({ limit: 10 })).json<QueryResponse>();
    expect(page1.next_cursor).not.toBeNull();

    const cursor = decodeCursor(page1.next_cursor!)!;
    const oldest = page1.items[page1.items.length - 1]!;
    expect(cursor.t).toBe(oldest.timestamp);
    expect(cursor.i).toBe(oldest.id);

    const newerStmt = ctx.db.prepare(
      `INSERT INTO logs (id, timestamp, source, level, message, context, trace_id, user_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 5; i++) {
      newerStmt.run(ulid(), BASE_TS + 100_000 + i, 'late', 'info', `late ${i}`, null, null, null, Date.now());
    }

    const page2 = (
      await get({ limit: 10, cursor: page1.next_cursor! })
    ).json<QueryResponse>();
    page2.items.forEach((it) => expect(it.source).not.toBe('late'));
  });

  it('rejects an unknown level', async () => {
    const res = await get({ level: 'spam' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.code).toBe('validation_error');
  });

  it('rejects limit > 1000', async () => {
    const res = await get({ limit: 1001 });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid cursor', async () => {
    const res = await get({ cursor: 'not-a-valid-cursor' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.code).toBe('validation_error');
  });

  it('rejects requests without an API key', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/logs' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /logs — activity field filters', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = buildTestApp({ API_KEY: 'k' });
    await ctx.app.ready();

    const stmt = ctx.db.prepare(
      `INSERT INTO logs (
         id, timestamp, source, level, message, context,
         trace_id, user_id, entity_type, entity_id, action, client_id, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const rows: Array<{
      entity_type: string | null;
      entity_id: string | null;
      action: string | null;
      client_id: string | null;
    }> = [
      { entity_type: 'Procurement', entity_id: '42', action: 'created', client_id: 'tenant-A' },
      { entity_type: 'Procurement', entity_id: '42', action: 'approved', client_id: 'tenant-A' },
      { entity_type: 'Procurement', entity_id: '99', action: 'created', client_id: 'tenant-B' },
      { entity_type: 'Offer', entity_id: '7', action: 'created', client_id: 'tenant-A' },
      { entity_type: 'Offer', entity_id: '7', action: 'cancelled', client_id: 'tenant-A' },
      { entity_type: null, entity_id: null, action: null, client_id: null },
    ];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      stmt.run(
        ulid(),
        BASE_TS + i * 1000,
        'kesh-back',
        'info',
        `event ${i}`,
        null,
        null,
        null,
        r.entity_type,
        r.entity_id,
        r.action,
        r.client_id,
        Date.now(),
      );
    }
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.db.close();
  });

  function get(query: Record<string, string | number>) {
    const qs = new URLSearchParams(
      Object.entries(query).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
    return ctx.app.inject({
      method: 'GET',
      url: `/logs?${qs}`,
      headers: { 'x-api-key': 'k' },
    });
  }

  it('filters by entity_type', async () => {
    const body = (await get({ entity_type: 'Procurement' })).json<QueryResponse>();
    expect(body.items).toHaveLength(3);
    body.items.forEach((it) => expect(it.entity_type).toBe('Procurement'));
  });

  it('scopes activity to a specific entity (entity_type + entity_id)', async () => {
    const body = (await get({ entity_type: 'Procurement', entity_id: '42' })).json<QueryResponse>();
    expect(body.items).toHaveLength(2);
    body.items.forEach((it) => {
      expect(it.entity_type).toBe('Procurement');
      expect(it.entity_id).toBe('42');
    });
    const actions = body.items.map((i) => i.action).sort();
    expect(actions).toEqual(['approved', 'created']);
  });

  it('filters by action', async () => {
    const body = (await get({ action: 'created' })).json<QueryResponse>();
    expect(body.items).toHaveLength(3);
    body.items.forEach((it) => expect(it.action).toBe('created'));
  });

  it('filters by client_id (multi-tenant slice)', async () => {
    const body = (await get({ client_id: 'tenant-A' })).json<QueryResponse>();
    expect(body.items).toHaveLength(4);
    body.items.forEach((it) => expect(it.client_id).toBe('tenant-A'));
  });

  it('combines activity filters with each other', async () => {
    const body = (
      await get({ client_id: 'tenant-A', entity_type: 'Offer', action: 'cancelled' })
    ).json<QueryResponse>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.entity_id).toBe('7');
  });
});
