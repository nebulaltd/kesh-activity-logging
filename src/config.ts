import { z } from 'zod';

const EmptyStringAsUndefined = (value: unknown) => (value === '' ? undefined : value);

export const LOG_PULL_MODES = ['off', 'interval', 'oneshot'] as const;

export type LogPullMode = (typeof LOG_PULL_MODES)[number];

export interface LogPullSource {
  name: string;
  url: string;
  apiKey: string;
}

const SOURCE_URL_PATTERN = /^LOG_PULL_SOURCE_(\d+)_URL$/;

const SHORTHAND_SOURCE_NAME = 'default';

const ConfigSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_PATH: z.string().default('./data/logs.db'),
    API_KEY: z.string().min(1, 'API_KEY is required'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    LOG_PULL_MODE: z.preprocess(EmptyStringAsUndefined, z.enum(LOG_PULL_MODES).default('off')),
    LOG_PULL_SOURCE_URL: z.preprocess(EmptyStringAsUndefined, z.string().url().optional()),
    LOG_PULL_API_KEY: z.preprocess(EmptyStringAsUndefined, z.string().min(1).optional()),
    LOG_PULL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    LOG_PULL_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(500),
    LOG_PULL_MAX_ITERATIONS: z.coerce.number().int().positive().max(10_000).default(20),
    LOG_PULL_HEARTBEAT_URL: z.preprocess(EmptyStringAsUndefined, z.string().url().optional()),
  })
  .superRefine((config, ctx) => {
    if (config.LOG_PULL_SOURCE_URL && !config.LOG_PULL_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOG_PULL_API_KEY'],
        message: 'LOG_PULL_API_KEY is required when LOG_PULL_SOURCE_URL is set',
      });
    }
  });

type BaseConfig = z.infer<typeof ConfigSchema>;

export type Config = BaseConfig & { LOG_PULL_SOURCES: LogPullSource[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = ConfigSchema.parse(env);
  const sources = resolveSources(env, base);

  if (base.LOG_PULL_MODE !== 'off' && sources.length === 0) {
    throw new Error(`LOG_PULL_MODE is "${base.LOG_PULL_MODE}" but no pull source is configured`);
  }

  return { ...base, LOG_PULL_SOURCES: sources };
}

function resolveSources(env: NodeJS.ProcessEnv, base: BaseConfig): LogPullSource[] {
  const indexed = readIndexedSources(env);
  if (indexed.length > 0) return assertUniqueNames(indexed);

  if (!base.LOG_PULL_SOURCE_URL || !base.LOG_PULL_API_KEY) return [];

  return [
    { name: SHORTHAND_SOURCE_NAME, url: base.LOG_PULL_SOURCE_URL, apiKey: base.LOG_PULL_API_KEY },
  ];
}

function readIndexedSources(env: NodeJS.ProcessEnv): LogPullSource[] {
  const indexes = Object.keys(env)
    .map((key) => SOURCE_URL_PATTERN.exec(key))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right);

  const sources: LogPullSource[] = [];

  for (const index of indexes) {
    const url = env[`LOG_PULL_SOURCE_${index}_URL`];
    if (!url) continue;

    if (!isUrl(url)) {
      throw new Error(`LOG_PULL_SOURCE_${index}_URL is not a valid URL`);
    }

    const apiKey = env[`LOG_PULL_SOURCE_${index}_API_KEY`];
    if (!apiKey) {
      throw new Error(
        `LOG_PULL_SOURCE_${index}_API_KEY is required when LOG_PULL_SOURCE_${index}_URL is set`,
      );
    }

    sources.push({ name: env[`LOG_PULL_SOURCE_${index}_NAME`] || `source-${index}`, url, apiKey });
  }

  return sources;
}

function assertUniqueNames(sources: LogPullSource[]): LogPullSource[] {
  const seen = new Set<string>();

  for (const source of sources) {
    if (seen.has(source.name)) {
      throw new Error(`Duplicate pull source name "${source.name}"`);
    }
    seen.add(source.name);
  }

  return sources;
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
