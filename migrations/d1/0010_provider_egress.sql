-- Per-run provider network identity. Additive-only.

ALTER TABLE agent_runs ADD COLUMN provider_egress_ip TEXT;
ALTER TABLE agent_runs ADD COLUMN provider_eip_id TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_runs_provider_egress_ip
  ON agent_runs(provider, provider_egress_ip, created_at);
