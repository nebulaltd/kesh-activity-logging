import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildTestApp, type TestApp } from './helpers/buildApp';

interface IngestSuccess {
  id: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface LogRowDb {
  id: string;
  timestamp: number;
  source: string;
  level: string;
  message: string;
  context: string | null;
  trace_id: string | null;
  user_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  action: string | null;
  client_id: string | null;
  received_at: number;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('POST /logs', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = buildTestApp({ API_KEY: 'k' });
    await ctx.app.ready();
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.db.close();
  });

  function post(body: unknown) {
    return ctx.app.inject({
      method: 'POST',
      url: '/logs',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('inserts a valid log and returns 201 with a ULID', async () => {
    const before = Date.now();
    const res = await post({ source: 'svc', level: 'info', message: 'hello' });
    expect(res.statusCode).toBe(201);
    const id = res.json<IngestSuccess>().id;
    expect(id).toMatch(ULID_RE);

    const row = ctx.db.query<LogRowDb, [string]>('SELECT * FROM logs WHERE id = ?').get(id);
    expect(row).toBeTruthy();
    expect(row?.source).toBe('svc');
    expect(row?.level).toBe('info');
    expect(row?.message).toBe('hello');
    expect(row?.context).toBeNull();
    expect(row?.trace_id).toBeNull();
    expect(row?.user_id).toBeNull();
    expect(row?.received_at).toBeGreaterThanOrEqual(before);
    expect(row?.timestamp).toBe(row?.received_at ?? -1);
  });

  it('honors a client-supplied timestamp and serializes context as JSON', async () => {
    const ts = 1_700_000_000_000;
    const res = await post({
      timestamp: ts,
      source: 'svc',
      level: 'warn',
      message: 'x',
      context: { foo: 1, nested: { bar: 'baz' } },
      trace_id: 't1',
      user_id: 'u1',
    });
    expect(res.statusCode).toBe(201);
    const id = res.json<IngestSuccess>().id;
    const row = ctx.db.query<LogRowDb, [string]>('SELECT * FROM logs WHERE id = ?').get(id);
    expect(row).toBeTruthy();
    expect(row?.timestamp).toBe(ts);
    expect(row?.trace_id).toBe('t1');
    expect(row?.user_id).toBe('u1');
    expect(JSON.parse(row?.context ?? 'null')).toEqual({ foo: 1, nested: { bar: 'baz' } });
  });

  it('stores activity fields (entity_type, entity_id, action, client_id) when provided', async () => {
    const res = await post({
      source: 'kesh-back',
      level: 'info',
      message: 'procurement approved',
      entity_type: 'Procurement',
      entity_id: '42',
      action: 'approved',
      client_id: 'tenant-7',
    });
    expect(res.statusCode).toBe(201);
    const id = res.json<IngestSuccess>().id;
    const row = ctx.db.query<LogRowDb, [string]>('SELECT * FROM logs WHERE id = ?').get(id);
    expect(row?.entity_type).toBe('Procurement');
    expect(row?.entity_id).toBe('42');
    expect(row?.action).toBe('approved');
    expect(row?.client_id).toBe('tenant-7');
  });

  it('leaves activity fields null when not provided', async () => {
    const res = await post({ source: 'svc', level: 'info', message: 'plain log' });
    expect(res.statusCode).toBe(201);
    const id = res.json<IngestSuccess>().id;
    const row = ctx.db.query<LogRowDb, [string]>('SELECT * FROM logs WHERE id = ?').get(id);
    expect(row?.entity_type).toBeNull();
    expect(row?.entity_id).toBeNull();
    expect(row?.action).toBeNull();
    expect(row?.client_id).toBeNull();
  });

  it('rejects missing source', async () => {
    const res = await post({ level: 'info', message: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.code).toBe('validation_error');
  });

  it('rejects unknown level', async () => {
    const res = await post({ source: 'svc', level: 'spam', message: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.code).toBe('validation_error');
  });

  it('rejects empty message', async () => {
    const res = await post({ source: 'svc', level: 'info', message: '' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-object context', async () => {
    const res = await post({ source: 'svc', level: 'info', message: 'x', context: 'oops' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown extra fields (strict schema)', async () => {
    const res = await post({ source: 'svc', level: 'info', message: 'x', extra: 'nope' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects requests without an API key', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/logs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ source: 'svc', level: 'info', message: 'hi' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 413 when body exceeds the configured limit', async () => {
    const small = buildTestApp({ API_KEY: 'k', BODY_LIMIT_BYTES: 200 });
    await small.app.ready();
    try {
      const big = 'x'.repeat(500);
      const res = await small.app.inject({
        method: 'POST',
        url: '/logs',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
        payload: JSON.stringify({ source: 'svc', level: 'info', message: big }),
      });
      expect(res.statusCode).toBe(413);
    } finally {
      await small.app.close();
      small.db.close();
    }
  });
});
