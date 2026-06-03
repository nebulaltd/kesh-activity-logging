import { z } from 'zod';

const ConfigSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_PATH: z.string().default('./data/logs.db'),
    API_KEY: z.string().min(1, 'API_KEY is required'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    LOG_PULL_SOURCE_URL: z.string().url().optional(),
    LOG_PULL_API_KEY: z.string().min(1).optional(),
    LOG_PULL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    LOG_PULL_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(500),
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

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
