-- P1 pilot lifecycle, retention, and administrative metadata. Additive-only.

ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN updated_at TEXT;
UPDATE users SET updated_at = COALESCE(updated_at, created_at);

ALTER TABLE api_tokens ADD COLUMN rotated_from_token_id TEXT;

ALTER TABLE projects ADD COLUMN artifact_retention_days INTEGER;
ALTER TABLE projects ADD COLUMN metadata_retention_days INTEGER;
ALTER TABLE projects ADD COLUMN audit_retention_days INTEGER;

ALTER TABLE tasks ADD COLUMN cancelled_at TEXT;
ALTER TABLE tasks ADD COLUMN cancelled_by TEXT;

ALTER TABLE audit_logs ADD COLUMN project_id TEXT;
UPDATE audit_logs
SET project_id = (SELECT t.project_id FROM tasks t WHERE t.id = audit_logs.entity_id)
WHERE entity_type = 'task' AND project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_status_created_at
  ON users(status, created_at);
CREATE INDEX IF NOT EXISTS idx_api_tokens_state_created_at
  ON api_tokens(revoked_at, expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_api_tokens_rotated_from
  ON api_tokens(rotated_from_token_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_created_at
  ON artifacts(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_finished_at
  ON tasks(finished_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_action_created_at
  ON audit_logs(actor, action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_project_created_at
  ON audit_logs(project_id, created_at);
