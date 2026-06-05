ALTER TABLE logs ADD COLUMN remote_source TEXT;
ALTER TABLE logs ADD COLUMN remote_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_remote_source_id ON logs (remote_source, remote_id);
