-- P1 durable auth/RBAC schema. Additive-only for D1 rollout safety.

CREATE TABLE IF NOT EXISTS project_memberships (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reader' CHECK (role IN ('owner', 'admin', 'operator', 'reader')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_memberships_user_project
  ON project_memberships(user_id, project_id);

CREATE INDEX IF NOT EXISTS idx_project_memberships_project
  ON project_memberships(project_id);

CREATE INDEX IF NOT EXISTS idx_project_memberships_project_role
  ON project_memberships(project_id, role);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash
  ON api_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user
  ON api_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_api_tokens_active_user
  ON api_tokens(user_id, revoked_at, expires_at);

INSERT OR IGNORE INTO project_memberships (
  id,
  project_id,
  user_id,
  role,
  status,
  created_at,
  updated_at
)
SELECT
  'pm_project-default_admin',
  'project-default',
  'admin',
  'owner',
  'active',
  '2026-06-15T00:00:00.000Z',
  '2026-06-15T00:00:00.000Z'
WHERE EXISTS (SELECT 1 FROM users WHERE id = 'admin')
  AND EXISTS (SELECT 1 FROM projects WHERE id = 'project-default');
