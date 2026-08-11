-- P1 lifecycle compare-and-set guards. Additive-only.

ALTER TABLE tasks ADD COLUMN dispatch_claim TEXT;
ALTER TABLE api_tokens ADD COLUMN rotation_claim TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_dispatch_claim
  ON tasks(dispatch_claim);
CREATE INDEX IF NOT EXISTS idx_api_tokens_rotation_claim
  ON api_tokens(rotation_claim);

-- Keep the last active project owner even when two membership updates race.
CREATE TRIGGER IF NOT EXISTS trg_project_memberships_keep_last_owner_update
BEFORE UPDATE OF role, status ON project_memberships
WHEN OLD.role = 'owner'
  AND OLD.status = 'active'
  AND (NEW.role <> 'owner' OR NEW.status <> 'active')
  AND (
    SELECT COUNT(*) FROM project_memberships
    WHERE project_id = OLD.project_id AND role = 'owner' AND status = 'active'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'project must retain at least one active owner');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_memberships_keep_last_owner_delete
BEFORE DELETE ON project_memberships
WHEN OLD.role = 'owner'
  AND OLD.status = 'active'
  AND (
    SELECT COUNT(*) FROM project_memberships
    WHERE project_id = OLD.project_id AND role = 'owner' AND status = 'active'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'project must retain at least one active owner');
END;
