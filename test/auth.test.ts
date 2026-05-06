import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildTestApp, type TestApp } from './helpers/buildApp';

interface ErrorBody {
  error: { code: string; message: string };
}

describe('X-API-Key auth', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = buildTestApp({ API_KEY: 'secret-123' });
    ctx.app.get('/whoami', () => ({ ok: true }));
    await ctx.app.ready();
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.db.close();
  });

  it('rejects requests with no key', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/whoami' });
    expect(res.statusCode).toBe(401);
    const body = res.json<ErrorBody>();
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).toBeTruthy();
  });

  it('rejects requests with the wrong key', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-api-key': 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe('unauthorized');
  });

  it('rejects requests where the key has the right length but wrong bytes', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-api-key': 'secret-XYZ' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts requests with the correct key', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-api-key': 'secret-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>()).toEqual({ ok: true });
  });

  it('does not require a key for /health', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('does not require a key for /health with query string', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health?probe=1' });
    expect(res.statusCode).toBe(200);
  });
});
