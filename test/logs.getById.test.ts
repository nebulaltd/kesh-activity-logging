import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildTestApp, type TestApp } from './helpers/buildApp';

interface LogResponseBody {
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
interface ErrorBody {
  error: { code: string; message: string };
}

describe('GET /logs/:id', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = buildTestApp({ API_KEY: 'k' });
    await ctx.app.ready();
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.db.close();
  });

  async function ingest(body: Record<string, unknown>): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/logs',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it('returns the inserted log with context parsed back to an object', async () => {
    const id = await ingest({
      source: 'svc',
      level: 'info',
      message: 'hi',
      context: { a: 1, nested: { b: 'c' } },
      trace_id: 't',
      user_id: 'u',
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/logs/${id}`,
      headers: { 'x-api-key': 'k' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<LogResponseBody>();
    expect(body.id).toBe(id);
    expect(body.source).toBe('svc');
    expect(body.level).toBe('info');
    expect(body.message).toBe('hi');
    expect(body.context).toEqual({ a: 1, nested: { b: 'c' } });
    expect(body.trace_id).toBe('t');
    expect(body.user_id).toBe('u');
    expect(typeof body.timestamp).toBe('number');
    expect(typeof body.received_at).toBe('number');
  });

  it('returns activity fields when they were stored', async () => {
    const id = await ingest({
      source: 'kesh-back',
      level: 'info',
      message: 'procurement created',
      entity_type: 'Procurement',
      entity_id: '42',
      action: 'created',
      client_id: 'tenant-A',
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/logs/${id}`,
      headers: { 'x-api-key': 'k' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<LogResponseBody>();
    expect(body.entity_type).toBe('Procurement');
    expect(body.entity_id).toBe('42');
    expect(body.action).toBe('created');
    expect(body.client_id).toBe('tenant-A');
  });

  it('returns null context when not provided', async () => {
    const id = await ingest({ source: 'svc', level: 'info', message: 'hi' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/logs/${id}`,
      headers: { 'x-api-key': 'k' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<LogResponseBody>().context).toBeNull();
  });

  it('returns 404 for unknown id', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/logs/01ABCDEFGHJKMNPQRSTVWXYZ00',
      headers: { 'x-api-key': 'k' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorBody>().error.code).toBe('not_found');
  });

  it('returns 401 without an API key', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/logs/anything' });
    expect(res.statusCode).toBe(401);
  });
});
