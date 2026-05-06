ALTER TABLE logs ADD COLUMN entity_type TEXT;
ALTER TABLE logs ADD COLUMN entity_id TEXT;
ALTER TABLE logs ADD COLUMN action TEXT;
ALTER TABLE logs ADD COLUMN client_id TEXT;

CREATE INDEX IF NOT EXISTS idx_logs_entity ON logs (entity_type, entity_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_client_timestamp ON logs (client_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_action_timestamp ON logs (action, timestamp DESC);
