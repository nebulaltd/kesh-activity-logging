export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogRow {
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

export interface LogResponse {
  id: string;
  timestamp: number;
  source: string;
  level: LogLevel;
  message: string;
  context: Record<string, unknown> | null;
  trace_id: string | null;
  user_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  action: string | null;
  client_id: string | null;
  received_at: number;
}
