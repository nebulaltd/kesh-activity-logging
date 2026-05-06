CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY NOT NULL,
  timestamp INTEGER NOT NULL,
  source TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug','info','warn','error','fatal')),
  message TEXT NOT NULL,
  context TEXT,
  trace_id TEXT,
  user_id TEXT,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_source_timestamp ON logs (source, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level_timestamp ON logs (level, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_trace_id ON logs (trace_id);
