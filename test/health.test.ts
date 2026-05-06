import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildTestApp, type TestApp } from './helpers/buildApp';

describe('GET /health', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = buildTestApp();
    await ctx.app.ready();
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.db.close();
  });

  it('returns 200 ok without auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>()).toEqual({ status: 'ok' });
  });
});
