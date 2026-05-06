import type { Database } from 'bun:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../lib/errors';
import { newId } from '../lib/id';
import { decodeCursor, encodeCursor } from './cursor';
import { getLogById, insertLog, queryLogs } from './repository';
import { InsertLogSchema, QueryLogsSchema } from './schema';

const IdParamsSchema = z.object({ id: z.string().min(1).max(255) });

export function registerLogRoutes(app: FastifyInstance, db: Database): void {
  app.post('/logs', (request, reply) => {
    const parsed = InsertLogSchema.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    const input = parsed.data;
    const receivedAt = Date.now();
    const id = newId();

    insertLog(db, {
      id,
      timestamp: input.timestamp ?? receivedAt,
      source: input.source,
      level: input.level,
      message: input.message,
      context: input.context ? JSON.stringify(input.context) : null,
      trace_id: input.trace_id ?? null,
      user_id: input.user_id ?? null,
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id ?? null,
      action: input.action ?? null,
      client_id: input.client_id ?? null,
      received_at: receivedAt,
    });

    return reply.status(201).send({ id });
  });

  app.get('/logs', (request) => {
    const parsed = QueryLogsSchema.safeParse(request.query);
    if (!parsed.success) {
      throw parsed.error;
    }
    const q = parsed.data;

    let cursor;
    if (q.cursor) {
      const decoded = decodeCursor(q.cursor);
      if (!decoded) throw new ValidationError('Invalid cursor');
      cursor = decoded;
    }

    const { items, hasMore, lastIncluded } = queryLogs(db, {
      source: q.source,
      level: q.level,
      from: q.from,
      to: q.to,
      trace_id: q.trace_id,
      user_id: q.user_id,
      entity_type: q.entity_type,
      entity_id: q.entity_id,
      action: q.action,
      client_id: q.client_id,
      q: q.q,
      cursor,
      limit: q.limit,
    });

    const next_cursor =
      hasMore && lastIncluded
        ? encodeCursor({ t: lastIncluded.timestamp, i: lastIncluded.id })
        : null;

    return { items, next_cursor };
  });

  app.get('/logs/:id', (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const log = getLogById(db, id);
    if (!log) throw new NotFoundError();
    return log;
  });
}
