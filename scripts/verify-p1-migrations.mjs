import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const python = String.raw`
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

root = Path(sys.argv[1])
migrations_dir = root / 'migrations' / 'd1'
migrations = sorted(migrations_dir.glob('*.sql'))
required_tables = {
    'users': ['id', 'email', 'role', 'status', 'created_at', 'updated_at'],
    'projects': ['id', 'name', 'owner_id', 'scope_json', 'artifact_retention_days', 'metadata_retention_days', 'audit_retention_days'],
    'tasks': ['id', 'project_id', 'created_by', 'max_cost_usd', 'deadletter_reason', 'cancelled_at', 'cancelled_by', 'dispatch_claim'],
    'task_shards': ['id', 'task_id', 'retry_count', 'deadletter_reason'],
    'agent_runs': ['id', 'task_id', 'callback_token', 'last_heartbeat_at', 'timeout_at', 'retryable', 'provider_cleanup_attempts', 'provider_cleanup_last_error', 'provider_cleanup_completed_at', 'provider_egress_ip', 'provider_eip_id', 'provider_status', 'provider_container_state', 'provider_status_reason', 'provider_status_message', 'provider_exit_code', 'provider_events_json', 'provider_diagnostics_updated_at'],
    'project_memberships': ['id', 'project_id', 'user_id', 'role', 'status', 'created_at', 'updated_at'],
    'api_tokens': ['id', 'user_id', 'token_hash', 'name', 'scopes_json', 'expires_at', 'revoked_at', 'last_used_at', 'rotated_from_token_id', 'rotation_claim', 'created_at', 'updated_at'],
    'audit_logs': ['id', 'actor', 'action', 'entity_type', 'entity_id', 'project_id', 'metadata_json', 'created_at'],
}
required_indexes = {
    'idx_project_memberships_user_project',
    'idx_project_memberships_project',
    'idx_project_memberships_project_role',
    'idx_api_tokens_token_hash',
    'idx_api_tokens_user',
    'idx_api_tokens_active_user',
    'idx_agent_runs_provider_cleanup',
    'idx_agent_runs_provider_egress_ip',
    'idx_agent_runs_provider_diagnostics',
    'idx_users_status_created_at',
    'idx_api_tokens_state_created_at',
    'idx_api_tokens_rotated_from',
    'idx_artifacts_created_at',
    'idx_tasks_finished_at',
    'idx_audit_logs_created_at',
    'idx_audit_logs_actor_action_created_at',
    'idx_audit_logs_project_created_at',
    'idx_tasks_dispatch_claim',
    'idx_api_tokens_rotation_claim',
}
required_triggers = {
    'trg_project_memberships_keep_last_owner_update',
    'trg_project_memberships_keep_last_owner_delete',
}

def apply_all(db_path):
    con = sqlite3.connect(db_path)
    try:
        for path in migrations:
            con.executescript(path.read_text())
        con.commit()
        return inspect(con)
    finally:
        con.close()

def ensure_migration_log(con):
    con.execute('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)')

def apply_missing_like_wrangler(con):
    ensure_migration_log(con)
    applied = {row[0] for row in con.execute('SELECT name FROM d1_migrations')}
    applied_now = []
    for path in migrations:
        if path.name in applied:
            continue
        con.executescript(path.read_text())
        con.execute('INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)', (path.name,))
        applied_now.append(path.name)
    con.commit()
    return applied_now

def inspect(con):
    tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    missing_tables = sorted(set(required_tables) - tables)
    table_columns = {}
    missing_columns = {}
    for table, cols in required_tables.items():
        found = [row[1] for row in con.execute(f'PRAGMA table_info({table})')]
        table_columns[table] = found
        missing = [col for col in cols if col not in found]
        if missing:
            missing_columns[table] = missing
    indexes = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    missing_indexes = sorted(required_indexes - indexes)
    triggers = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
    missing_triggers = sorted(required_triggers - triggers)
    admin_membership = con.execute(
        "SELECT role, status FROM project_memberships WHERE project_id='project-default' AND user_id='admin'"
    ).fetchone()
    token_hash_unique = False
    for idx in con.execute('PRAGMA index_list(api_tokens)'):
        index_name = idx[1]
        is_unique = bool(idx[2])
        if not is_unique:
            continue
        columns = [row[2] for row in con.execute(f'PRAGMA index_info({index_name})')]
        if columns == ['token_hash']:
            token_hash_unique = True
            break
    return {
        'tables': sorted(tables & set(required_tables)),
        'table_columns': table_columns,
        'missing_tables': missing_tables,
        'missing_columns': missing_columns,
        'indexes': sorted(indexes & required_indexes),
        'missing_indexes': missing_indexes,
        'triggers': sorted(triggers & required_triggers),
        'missing_triggers': missing_triggers,
        'last_owner_guard_enforced': check_last_owner_guard(con),
        'admin_membership': {'role': admin_membership[0], 'status': admin_membership[1]} if admin_membership else None,
        'token_hash_unique_index_present': token_hash_unique,
    }

def assert_ok(label, info):
    errors = []
    if info['missing_tables']:
        errors.append(f"missing tables: {info['missing_tables']}")
    if info['missing_columns']:
        errors.append(f"missing columns: {info['missing_columns']}")
    if info['missing_indexes']:
        errors.append(f"missing indexes: {info['missing_indexes']}")
    if info['missing_triggers']:
        errors.append(f"missing triggers: {info['missing_triggers']}")
    if not info['last_owner_guard_enforced']:
        errors.append('last active project owner trigger is not enforced')
    if info['admin_membership'] != {'role': 'owner', 'status': 'active'}:
        errors.append(f"admin membership not backfilled: {info['admin_membership']}")
    if not info['token_hash_unique_index_present']:
        errors.append('api_tokens.token_hash is not covered by a unique index')
    if errors:
        raise AssertionError(f"{label}: " + '; '.join(errors))

def check_last_owner_guard(con):
    con.execute('SAVEPOINT owner_guard_test')
    enforced = False
    try:
        con.execute("UPDATE project_memberships SET role='reader' WHERE project_id='project-default' AND user_id='admin'")
    except sqlite3.IntegrityError as exc:
        enforced = 'project must retain at least one active owner' in str(exc)
    finally:
        con.execute('ROLLBACK TO owner_guard_test')
        con.execute('RELEASE owner_guard_test')
    return enforced

with tempfile.TemporaryDirectory() as tmp:
    fresh_db = Path(tmp) / 'fresh.sqlite'
    fresh = apply_all(fresh_db)
    assert_ok('fresh-db', fresh)

    candidates = sorted((root / '.wrangler' / 'state' / 'v3' / 'd1' / 'miniflare-D1DatabaseObject').glob('*.sqlite'))
    existing = {'status': 'skipped', 'reason': 'no existing Miniflare D1 sqlite DB found'}
    data_candidates = [p for p in candidates if p.name != 'metadata.sqlite']
    if data_candidates:
        source = data_candidates[0]
        copied = Path(tmp) / 'existing-copy.sqlite'
        shutil.copy2(source, copied)
        con = sqlite3.connect(copied)
        try:
            applied_now = apply_missing_like_wrangler(con)
            upgraded = inspect(con)
            assert_ok('existing-db-copy', upgraded)
            rows = list(con.execute("SELECT name FROM d1_migrations WHERE name='0007_provider_cleanup.sql'"))
            if not rows:
                raise AssertionError('existing-db-copy: 0007_provider_cleanup.sql not recorded in copied migration log')
            existing = {
                'status': 'validated-copy',
                'source': str(source.relative_to(root)),
                'applied_now': applied_now,
                'schema': upgraded,
            }
        finally:
            con.close()

print(json.dumps({
    'ok': True,
    'migrations': [p.name for p in migrations],
    'fresh_db': fresh,
    'existing_db': existing,
    'network': 'not used',
    'cloud_credentials': 'not used',
}, indent=2, sort_keys=True))
`;

const pythonCandidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
let result;
for (const candidate of pythonCandidates) {
  const args = candidate === 'py' ? ['-3', '-c', python, root] : ['-c', python, root];
  const attempted = spawnSync(candidate, args, { encoding: 'utf8' });
  if (!attempted.error && attempted.status === 0) {
    result = attempted;
    break;
  }
  if (!result || attempted.stderr || attempted.stdout) result = attempted;
}
if (!result) throw new Error('Python 3 with sqlite3 is required for migration verification');
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout);
assert.equal(report.ok, true);
assert.ok(report.migrations.includes('0006_auth_rbac_tokens.sql'));
assert.ok(report.migrations.includes('0007_provider_cleanup.sql'));
assert.ok(report.migrations.includes('0008_p1_pilot.sql'));
assert.ok(report.migrations.includes('0009_p1_lifecycle_guards.sql'));
assert.ok(report.migrations.includes('0010_provider_egress.sql'));
assert.ok(report.migrations.includes('0011_provider_diagnostics.sql'));
assert.ok(report.fresh_db.tables.includes('project_memberships'));
assert.ok(report.fresh_db.tables.includes('api_tokens'));
assert.deepEqual(report.fresh_db.admin_membership, { role: 'owner', status: 'active' });
assert.equal(report.fresh_db.token_hash_unique_index_present, true);
assert.equal(report.network, 'not used');
assert.equal(report.cloud_credentials, 'not used');

console.log(JSON.stringify(report, null, 2));

if (!existsSync(resolve(root, 'migrations/d1/0006_auth_rbac_tokens.sql'))) {
  throw new Error('missing 0006_auth_rbac_tokens.sql');
}
if (!existsSync(resolve(root, 'migrations/d1/0007_provider_cleanup.sql'))) {
  throw new Error('missing 0007_provider_cleanup.sql');
}
