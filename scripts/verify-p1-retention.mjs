import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'worker/src/services/retention-service.ts'), 'utf8');
const auditEvents = [];
const retention = loadTsModule('worker/src/services/retention-service.ts', {
  '../ids': { nowIso: () => '2026-08-11T00:00:00.000Z' },
  './r2-service': { taskPrefix: (taskId) => `tenants/default/tasks/${taskId}` },
  './project-admin-service': { retentionDefaults: () => ({ artifact: 30, metadata: 180, audit: 180 }) },
  './audit-service': { writeAudit: async (_env, event) => { auditEvents.push(event); } },
});

const deletedArtifactIds = [];
const deletedTaskIds = [];
const deletedAuditIds = [];
const r2Deletes = [];
const env = {
  DB: {
    prepare(sql) { return fakeStatement(sql); },
    async batch(statements) {
      for (const statement of statements) {
        if (statement.sql.includes('DELETE FROM artifacts')) deletedArtifactIds.push(statement.values[0]);
        if (statement.sql.includes('DELETE FROM tasks')) deletedTaskIds.push(statement.values[0]);
        if (statement.sql.includes('DELETE FROM audit_logs')) deletedAuditIds.push(statement.values[0]);
      }
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  },
  ARTIFACTS: {
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      r2Deletes.push(list);
      if (list.includes('raw/fail.jsonl')) throw new Error('fixture R2 delete failure');
    },
    async list({ prefix }) {
      return { objects: [{ key: `${prefix}config.json` }, { key: `${prefix}targets.txt` }], truncated: false };
    },
  },
};

const actual = await retention.sweepRetention(env, { now: '2026-08-11T00:00:00.000Z' });
assert.deepEqual(JSON.parse(JSON.stringify(actual)), {
  dry_run: false,
  artifacts_checked: 2,
  artifacts_deleted: 1,
  artifact_delete_failures: 1,
  tasks_checked: 1,
  tasks_deleted: 1,
  task_delete_failures: 0,
  audit_logs_deleted: 4,
});
assert.deepEqual(deletedArtifactIds, ['artifact-good'], 'D1 artifact must remain when R2 deletion fails');
assert.deepEqual(deletedTaskIds, ['task-expired']);
assert.deepEqual(deletedAuditIds.sort(), ['audit-orphan', 'audit-project-1', 'audit-project-2', 'audit-system']);
assert.ok(r2Deletes.some((keys) => keys.includes('raw/good.jsonl') && keys.includes('search/good.md')));
assert.equal(auditEvents.at(-1)?.action, 'retention.sweep');

const beforePreview = { r2: r2Deletes.length, artifacts: deletedArtifactIds.length, tasks: deletedTaskIds.length, audits: deletedAuditIds.length };
const preview = await retention.sweepRetention(env, { dry_run: true, now: '2026-08-11T00:00:00.000Z' });
assert.equal(preview.dry_run, true);
assert.deepEqual({ r2: r2Deletes.length, artifacts: deletedArtifactIds.length, tasks: deletedTaskIds.length, audits: deletedAuditIds.length }, beforePreview, 'dry-run must not mutate R2 or D1');

assert.match(source, /julianday\(ar\.created_at\)\s*<\s*julianday\(\?\)/, 'artifact boundary must be strictly older than cutoff');
assert.match(source, /julianday\(t\.finished_at\)\s*<\s*julianday\(\?\)/, 'metadata boundary must be strictly older than cutoff');
assert.match(source, /NOT EXISTS \(SELECT 1 FROM artifacts ar WHERE ar\.task_id = t\.id\)/, 'task metadata must remain while artifact rows exist');

console.log(JSON.stringify({ ok: true, artifact_r2_first: true, r2_failure_retained_for_retry: true, dry_run_non_mutating: true, artifact_days: 30, metadata_days: 180, audit_days: 180, strict_cutoff: true, network: 'not used', cloud_credentials: 'not used' }, null, 2));

function fakeStatement(sql) {
  return {
    sql,
    values: [],
    bind(...values) { this.values = values; return this; },
    async all() {
    if (sql.includes('FROM tasks t INNER JOIN projects')) return { results: [{ id: 'task-expired', project_id: 'project-default' }] };
    if (sql.includes('FROM artifacts ar')) return { results: [
      { id: 'artifact-good', task_id: 'task-good', project_id: 'project-default', raw_r2_key: 'raw/good.jsonl', search_r2_key: 'search/good.md' },
      { id: 'artifact-fail', task_id: 'task-fail', project_id: 'project-default', raw_r2_key: 'raw/fail.jsonl', search_r2_key: null },
    ] };
    if (sql.includes('SELECT id, audit_retention_days FROM projects')) return { results: [{ id: 'project-default', audit_retention_days: 180 }] };
    if (sql.includes('SELECT id FROM audit_logs WHERE project_id = ?')) return { results: [{ id: 'audit-project-1' }, { id: 'audit-project-2' }] };
    if (sql.includes('SELECT id FROM audit_logs WHERE project_id IS NULL')) return { results: [{ id: 'audit-system' }] };
    if (sql.includes('NOT EXISTS (SELECT 1 FROM projects')) return { results: [{ id: 'audit-orphan' }] };
    throw new Error(`unexpected all SQL: ${sql}`);
    },
    async run() {
      if (sql.includes('DELETE FROM artifacts')) deletedArtifactIds.push(this.values[0]);
      return { success: true, meta: { changes: 1 } };
    },
  };
}

function loadTsModule(relativePath, requireMap) {
  const filePath = resolve(root, relativePath);
  const compiled = ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`verify-p1-retention cannot load ${specifier}`);
    },
    console,
    Date,
  }, { filename: filePath });
  return module.exports;
}
