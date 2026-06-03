import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { Config } from '../config';
import { newId } from '../lib/id';
import { LOG_LEVELS } from './schema';
import { insertRemoteLog } from './repository';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const NullableIdentifier = z.string().min(1).max(255).nullable().optional();

const RemoteLogSchema = z.object({
  id: z.string().min(1).max(255),
  timestamp: z.number().int().nonnegative(),
  source: z.string().min(1).max(255),
  level: z.enum(LOG_LEVELS),
  message: z.string().min(1),
  context: z.record(z.string(), z.unknown()).nullable().optional(),
  trace_id: NullableIdentifier,
  user_id: NullableIdentifier,
  entity_type: NullableIdentifier,
  entity_id: NullableIdentifier,
  action: NullableIdentifier,
  client_id: NullableIdentifier,
});

const RemoteLogsResponseSchema = z.object({ items: z.array(RemoteLogSchema) });

export type RemoteLog = z.infer<typeof RemoteLogSchema>;

export interface PullLogsOnceOptions {
  db: Database;
  config: Config;
  fetchFn?: FetchLike;
  now?: () => number;
}

export interface LogPullerOptions extends PullLogsOnceOptions {
  logger?: { error: (error: unknown) => void };
}

export async function fetchRemoteLogs(config: Config, fetchFn: FetchLike = fetch): Promise<RemoteLog[]> {
  if (!config.LOG_PULL_SOURCE_URL || !config.LOG_PULL_API_KEY) return [];

  const url = new URL(config.LOG_PULL_SOURCE_URL);
  url.searchParams.set('limit', String(config.LOG_PULL_BATCH_SIZE));

  const response = await fetchFn(url, {
    headers: { 'x-internal-api-key': config.LOG_PULL_API_KEY },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch remote logs: ${response.status}`);
  }

  return RemoteLogsResponseSchema.parse(await response.json()).items;
}

export async function ackRemoteLogs(config: Config, ids: string[], fetchFn: FetchLike = fetch): Promise<void> {
  if (!config.LOG_PULL_SOURCE_URL || !config.LOG_PULL_API_KEY || ids.length === 0) return;

  const url = new URL(config.LOG_PULL_SOURCE_URL);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ack`;
  url.search = '';

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': config.LOG_PULL_API_KEY,
    },
    body: JSON.stringify({ ids }),
  });

  if (!response.ok) {
    throw new Error(`Failed to acknowledge remote logs: ${response.status}`);
  }
}

export async function pullLogsOnce({ db, config, fetchFn = fetch, now = Date.now }: PullLogsOnceOptions): Promise<void> {
  const remoteLogs = await fetchRemoteLogs(config, fetchFn);
  const ackIds: string[] = [];
  const errors: unknown[] = [];

  for (const log of remoteLogs) {
    try {
      insertRemoteLog(db, {
        id: newId(),
        timestamp: log.timestamp,
        source: log.source,
        level: log.level,
        message: log.message,
        context: log.context ? JSON.stringify(log.context) : null,
        trace_id: log.trace_id ?? null,
        user_id: log.user_id ?? null,
        entity_type: log.entity_type ?? null,
        entity_id: log.entity_id ?? null,
        action: log.action ?? null,
        client_id: log.client_id ?? null,
        received_at: now(),
        remote_source: log.source,
        remote_id: log.id,
      });
      ackIds.push(log.id);
    } catch (error) {
      errors.push(error);
    }
  }

  await ackRemoteLogs(config, ackIds, fetchFn);

  if (errors.length > 0) {
    throw errors[0];
  }
}

export function startLogPuller(options: LogPullerOptions): () => void {
  if (!options.config.LOG_PULL_SOURCE_URL) return () => undefined;

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await pullLogsOnce(options);
    } catch (error) {
      options.logger?.error(error);
    } finally {
      running = false;
    }
  };

  void run();
  const interval = setInterval(() => void run(), options.config.LOG_PULL_INTERVAL_MS);
  return () => clearInterval(interval);
}
