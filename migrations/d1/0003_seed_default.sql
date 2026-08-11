INSERT OR IGNORE INTO users (id, email, role, created_at)
VALUES ('admin', 'admin@example.local', 'admin', '2026-06-03T00:00:00.000Z');

INSERT OR IGNORE INTO projects (id, name, owner_id, scope_json, created_at, updated_at)
VALUES ('project-default', 'Default Project', 'admin', '["example.com"]', '2026-06-03T00:00:00.000Z', '2026-06-03T00:00:00.000Z');
