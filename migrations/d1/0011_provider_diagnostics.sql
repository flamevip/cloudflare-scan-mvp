-- Bounded, sanitized provider startup diagnostics. Additive-only.

ALTER TABLE agent_runs ADD COLUMN provider_status TEXT;
ALTER TABLE agent_runs ADD COLUMN provider_container_state TEXT;
ALTER TABLE agent_runs ADD COLUMN provider_status_reason TEXT;
ALTER TABLE agent_runs ADD COLUMN provider_status_message TEXT;
ALTER TABLE agent_runs ADD COLUMN provider_exit_code INTEGER;
ALTER TABLE agent_runs ADD COLUMN provider_events_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_runs ADD COLUMN provider_diagnostics_updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_runs_provider_diagnostics
  ON agent_runs(provider, status, provider_diagnostics_updated_at, created_at);
