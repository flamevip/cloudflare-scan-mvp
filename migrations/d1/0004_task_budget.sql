-- Optional per-task budget used by provider auto-routing cost checks.
ALTER TABLE tasks ADD COLUMN max_cost_usd REAL;
