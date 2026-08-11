-- Retry/timeout metadata for bounded external-provider and agent-runtime convergence.

ALTER TABLE agent_runs ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE agent_runs ADD COLUMN timeout_at TEXT;
ALTER TABLE agent_runs ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_shards ADD COLUMN deadletter_reason TEXT;
ALTER TABLE tasks ADD COLUMN deadletter_reason TEXT;
