ALTER TABLE agent_runs ADD COLUMN provider_cleanup_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN provider_cleanup_last_error TEXT;
ALTER TABLE agent_runs ADD COLUMN provider_cleanup_completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_runs_provider_cleanup
  ON agent_runs(provider, status, provider_cleanup_completed_at, created_at);
