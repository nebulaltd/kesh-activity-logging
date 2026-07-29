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

  test('treats blank pull env vars as disabled', () => {
    const config = loadConfig({
      API_KEY: 'test-key',
      LOG_PULL_SOURCE_URL: '',
      LOG_PULL_API_KEY: '',
    });

    expect(config.LOG_PULL_SOURCE_URL).toBeUndefined();
    expect(config.LOG_PULL_API_KEY).toBeUndefined();
  });

  test('requires pull api key when source url is configured', () => {
    expect(() =>
      loadConfig({
        API_KEY: 'test-key',
        LOG_PULL_SOURCE_URL: 'https://kesh-back.example/internal/activity-logs',
      }),
    ).toThrow();
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

describe('loadConfig pull mode', () => {
  test('defaults to off so a query-only instance never pulls', () => {
    const config = loadConfig({ API_KEY: 'test-key' });

    expect(config.LOG_PULL_MODE).toBe('off');
    expect(config.LOG_PULL_SOURCES).toEqual([]);
    expect(config.LOG_PULL_MAX_ITERATIONS).toBe(20);
  });

  test('rejects an enabled mode without any source', () => {
    expect(() => loadConfig({ API_KEY: 'test-key', LOG_PULL_MODE: 'oneshot' })).toThrow(
      'no pull source is configured',
    );
  });

  test('rejects an unknown mode', () => {
    expect(() => loadConfig({ API_KEY: 'test-key', LOG_PULL_MODE: 'cron' })).toThrow();
  });
});

describe('loadConfig pull sources', () => {
  test('promotes the single-source shorthand to a named source', () => {
    const config = loadConfig({
      API_KEY: 'test-key',
      LOG_PULL_MODE: 'oneshot',
      LOG_PULL_SOURCE_URL: 'https://kesh-back.example/internal/activity-logs',
      LOG_PULL_API_KEY: 'pull-key',
    });

    expect(config.LOG_PULL_SOURCES).toEqual([
      {
        name: 'default',
        url: 'https://kesh-back.example/internal/activity-logs',
        apiKey: 'pull-key',
      },
    ]);
  });

  test('reads indexed sources in index order and ignores the shorthand', () => {
    const config = loadConfig({
      API_KEY: 'test-key',
      LOG_PULL_MODE: 'oneshot',
      LOG_PULL_SOURCE_URL: 'https://ignored.example/internal/activity-logs',
      LOG_PULL_API_KEY: 'ignored-key',
      LOG_PULL_SOURCE_2_NAME: 'onprem',
      LOG_PULL_SOURCE_2_URL: 'http://127.0.0.1:5050/internal/activity-logs',
      LOG_PULL_SOURCE_2_API_KEY: 'onprem-key',
      LOG_PULL_SOURCE_1_NAME: 'aws-live',
      LOG_PULL_SOURCE_1_URL: 'http://127.0.0.1:5055/internal/activity-logs',
      LOG_PULL_SOURCE_1_API_KEY: 'live-key',
    });

    expect(config.LOG_PULL_SOURCES.map((source) => source.name)).toEqual(['aws-live', 'onprem']);
  });

  test('defaults a missing source name to its index', () => {
    const config = loadConfig({
      API_KEY: 'test-key',
      LOG_PULL_SOURCE_3_URL: 'https://kesh-back.example/internal/activity-logs',
      LOG_PULL_SOURCE_3_API_KEY: 'key',
    });

    expect(config.LOG_PULL_SOURCES[0]?.name).toBe('source-3');
  });

  test('names the offending env var when a source api key is missing', () => {
    expect(() =>
      loadConfig({
        API_KEY: 'test-key',
        LOG_PULL_SOURCE_1_URL: 'https://kesh-back.example/internal/activity-logs',
      }),
    ).toThrow('LOG_PULL_SOURCE_1_API_KEY is required');
  });

  test('rejects an invalid source url', () => {
    expect(() =>
      loadConfig({
        API_KEY: 'test-key',
        LOG_PULL_SOURCE_1_URL: 'not-a-url',
        LOG_PULL_SOURCE_1_API_KEY: 'key',
      }),
    ).toThrow('LOG_PULL_SOURCE_1_URL is not a valid URL');
  });

  test('rejects duplicate source names because remote_source must stay unambiguous', () => {
    expect(() =>
      loadConfig({
        API_KEY: 'test-key',
        LOG_PULL_SOURCE_1_NAME: 'live',
        LOG_PULL_SOURCE_1_URL: 'https://a.example/internal/activity-logs',
        LOG_PULL_SOURCE_1_API_KEY: 'a',
        LOG_PULL_SOURCE_2_NAME: 'live',
        LOG_PULL_SOURCE_2_URL: 'https://b.example/internal/activity-logs',
        LOG_PULL_SOURCE_2_API_KEY: 'b',
      }),
    ).toThrow('Duplicate pull source name "live"');
  });
});
