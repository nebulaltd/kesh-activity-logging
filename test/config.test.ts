import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';

describe('loadConfig log pull settings', () => {
  test('uses disabled pull defaults when source url is absent', () => {
    const config = loadConfig({ API_KEY: 'test-key' });

    expect(config.LOG_PULL_SOURCE_URL).toBeUndefined();
    expect(config.LOG_PULL_API_KEY).toBeUndefined();
    expect(config.LOG_PULL_INTERVAL_MS).toBe(60_000);
    expect(config.LOG_PULL_BATCH_SIZE).toBe(500);
  });

  test('requires pull api key when source url is configured', () => {
    expect(() => loadConfig({ API_KEY: 'test-key', LOG_PULL_SOURCE_URL: 'https://kesh-back.example/internal/activity-logs' })).toThrow();
  });

  test('accepts explicit pull settings', () => {
    const config = loadConfig({
      API_KEY: 'test-key',
      LOG_PULL_SOURCE_URL: 'https://kesh-back.example/internal/activity-logs',
      LOG_PULL_API_KEY: 'pull-key',
      LOG_PULL_INTERVAL_MS: '30000',
      LOG_PULL_BATCH_SIZE: '250',
    });

    expect(config.LOG_PULL_SOURCE_URL).toBe('https://kesh-back.example/internal/activity-logs');
    expect(config.LOG_PULL_API_KEY).toBe('pull-key');
    expect(config.LOG_PULL_INTERVAL_MS).toBe(30_000);
    expect(config.LOG_PULL_BATCH_SIZE).toBe(250);
  });
});
