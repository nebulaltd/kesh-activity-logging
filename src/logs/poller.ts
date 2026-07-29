import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { Config, LogPullSource } from '../config';
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

export interface PullSourceResult {
  name: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  batches: number;
  hitIterationCap: boolean;
}

export interface PullRunResult {
  sources: PullSourceResult[];
  fetched: number;
  inserted: number;
  duplicates: number;
  hitIterationCap: boolean;
  durationMs: number;
}

export interface PullLogsOnceOptions {
  db: Database;
  config: Config;
  fetchFn?: FetchLike;
  now?: () => number;
}

export interface LogPullerOptions extends PullLogsOnceOptions {
  logger?: { error: (error: unknown) => void };
}

interface DrainSourceOptions {
  db: Database;
  source: LogPullSource;
  batchSize: number;
  maxIterations: number;
  fetchFn: FetchLike;
  now: () => number;
}

export async function fetchRemoteLogs(
  source: LogPullSource,
  batchSize: number,
  fetchFn: FetchLike = fetch,
): Promise<RemoteLog[]> {
  const url = new URL(source.url);
  url.searchParams.set('limit', String(batchSize));

  const response = await fetchFn(url, {
    headers: { 'x-internal-api-key': source.apiKey },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch remote logs from ${source.name}: ${response.status}`);
  }

  return RemoteLogsResponseSchema.parse(await response.json()).items;
}

export async function ackRemoteLogs(
  source: LogPullSource,
  ids: string[],
  fetchFn: FetchLike = fetch,
): Promise<void> {
  if (ids.length === 0) return;

  const url = new URL(source.url);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ack`;
  url.search = '';

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': source.apiKey,
    },
    body: JSON.stringify({ ids }),
  });

  if (!response.ok) {
    throw new Error(`Failed to acknowledge remote logs on ${source.name}: ${response.status}`);
  }
}

export async function drainSource(options: DrainSourceOptions): Promise<PullSourceResult> {
  const { db, source, batchSize, maxIterations, fetchFn, now } = options;
  const result: PullSourceResult = {
    name: source.name,
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    batches: 0,
    hitIterationCap: false,
  };

  while (result.batches < maxIterations) {
    const remoteLogs = await fetchRemoteLogs(source, batchSize, fetchFn);
    result.batches += 1;
    result.fetched += remoteLogs.length;

    const ackIds: string[] = [];
    let insertError: unknown = null;

    for (const log of remoteLogs) {
      try {
        const inserted = insertRemoteLog(db, {
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
          remote_source: source.name,
          remote_id: log.id,
        });

        if (inserted) result.inserted += 1;
        else result.duplicates += 1;

        ackIds.push(log.id);
      } catch (error) {
        insertError = insertError ?? error;
        break;
      }
    }

    await ackRemoteLogs(source, ackIds, fetchFn);

    if (insertError) throw insertError;
    if (remoteLogs.length < batchSize) return result;
  }

  result.hitIterationCap = true;
  return result;
}

export async function pullLogsOnce({
  db,
  config,
  fetchFn = fetch,
  now = Date.now,
}: PullLogsOnceOptions): Promise<PullRunResult> {
  const startedAt = now();
  const sources: PullSourceResult[] = [];
  let firstError: unknown = null;

  for (const source of config.LOG_PULL_SOURCES) {
    try {
      sources.push(
        await drainSource({
          db,
          source,
          batchSize: config.LOG_PULL_BATCH_SIZE,
          maxIterations: config.LOG_PULL_MAX_ITERATIONS,
          fetchFn,
          now,
        }),
      );
    } catch (error) {
      firstError = firstError ?? error;
    }
  }

  if (firstError) throw firstError;

  return {
    sources,
    fetched: sources.reduce((total, source) => total + source.fetched, 0),
    inserted: sources.reduce((total, source) => total + source.inserted, 0),
    duplicates: sources.reduce((total, source) => total + source.duplicates, 0),
    hitIterationCap: sources.some((source) => source.hitIterationCap),
    durationMs: now() - startedAt,
  };
}

export function startLogPuller(options: LogPullerOptions): () => void {
  if (options.config.LOG_PULL_MODE !== 'interval' || options.config.LOG_PULL_SOURCES.length === 0)
    return () => undefined;

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
