import type { Database } from 'bun:sqlite';
import type { Cursor } from './cursor';
import type { LogLevel, LogResponse, LogRow } from './types';

export interface InsertLogParams {
  id: string;
  timestamp: number;
  source: string;
  level: LogLevel;
  message: string;
  context: string | null;
  trace_id: string | null;
  user_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  action: string | null;
  client_id: string | null;
  received_at: number;
}

const INSERT_SQL = `
  INSERT INTO logs (
    id, timestamp, source, level, message, context,
    trace_id, user_id, entity_type, entity_id, action, client_id, received_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SELECT_COLS = `
  id, timestamp, source, level, message, context,
  trace_id, user_id, entity_type, entity_id, action, client_id, received_at
`;

const SELECT_BY_ID_SQL = `SELECT ${SELECT_COLS} FROM logs WHERE id = ?`;

export function insertLog(db: Database, params: InsertLogParams): void {
  db.query(INSERT_SQL).run(
    params.id,
    params.timestamp,
    params.source,
    params.level,
    params.message,
    params.context,
    params.trace_id,
    params.user_id,
    params.entity_type,
    params.entity_id,
    params.action,
    params.client_id,
    params.received_at,
  );
}

export function getLogById(db: Database, id: string): LogResponse | null {
  const row = db.query<LogRow, [string]>(SELECT_BY_ID_SQL).get(id);
  return row ? rowToResponse(row) : null;
}

export function rowToResponse(row: LogRow): LogResponse {
  return {
    id: row.id,
    timestamp: row.timestamp,
    source: row.source,
    level: row.level,
    message: row.message,
    context: row.context ? (JSON.parse(row.context) as Record<string, unknown>) : null,
    trace_id: row.trace_id,
    user_id: row.user_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    action: row.action,
    client_id: row.client_id,
    received_at: row.received_at,
  };
}

export interface QueryLogsFilters {
  source?: string;
  level?: LogLevel;
  from?: number;
  to?: number;
  trace_id?: string;
  user_id?: string;
  entity_type?: string;
  entity_id?: string;
  action?: string;
  client_id?: string;
  q?: string;
  cursor?: Cursor;
  limit: number;
}

export interface QueryLogsResult {
  items: LogResponse[];
  hasMore: boolean;
  lastIncluded: LogRow | null;
}

type Bind = string | number;

export function queryLogs(db: Database, filters: QueryLogsFilters): QueryLogsResult {
  const where: string[] = [];
  const params: Bind[] = [];

  if (filters.source) {
    where.push('source = ?');
    params.push(filters.source);
  }
  if (filters.level) {
    where.push('level = ?');
    params.push(filters.level);
  }
  if (filters.from !== undefined) {
    where.push('timestamp >= ?');
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    where.push('timestamp <= ?');
    params.push(filters.to);
  }
  if (filters.trace_id) {
    where.push('trace_id = ?');
    params.push(filters.trace_id);
  }
  if (filters.user_id) {
    where.push('user_id = ?');
    params.push(filters.user_id);
  }
  if (filters.entity_type) {
    where.push('entity_type = ?');
    params.push(filters.entity_type);
  }
  if (filters.entity_id) {
    where.push('entity_id = ?');
    params.push(filters.entity_id);
  }
  if (filters.action) {
    where.push('action = ?');
    params.push(filters.action);
  }
  if (filters.client_id) {
    where.push('client_id = ?');
    params.push(filters.client_id);
  }
  if (filters.q) {
    where.push('INSTR(message, ?) > 0');
    params.push(filters.q);
  }
  if (filters.cursor) {
    where.push('(timestamp, id) < (?, ?)');
    params.push(filters.cursor.t, filters.cursor.i);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT ${SELECT_COLS}
    FROM logs
    ${whereClause}
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `;
  params.push(filters.limit + 1);

  const rows = db.query<LogRow, Bind[]>(sql).all(...params);
  const hasMore = rows.length > filters.limit;
  const included = hasMore ? rows.slice(0, filters.limit) : rows;
  return {
    items: included.map(rowToResponse),
    hasMore,
    lastIncluded: included[included.length - 1] ?? null,
  };
}
