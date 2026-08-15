import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adminService = loadTsModule('worker/src/services/admin-service.ts', {
  '../auth': { hashBearerToken: async () => 'hash' },
  '../ids': { newId: (prefix) => `${prefix}_test`, nowIso: () => '2026-08-15T14:00:00.000Z' },
  '../response': { HttpError: class HttpError extends Error {} },
  './audit-service': { writeAudit: async () => undefined },
});

const boundValues = [];
const env = {
  AGENT_HEARTBEAT_TIMEOUT_SECONDS: '600',
  DB: {
    prepare(sql) {
      return {
        values: [],
        bind(...values) {
          this.values = values;
          boundValues.push(...values);
          return this;
        },
        async all() {
          if (sql.includes('FROM tasks GROUP BY status')) return { results: [{ status: 'completed', count: 4 }, { status: 'running', count: 1 }] };
          if (sql.includes("FROM tasks WHERE created_at >= datetime('now', '-24 hours')")) return { results: [{ status: 'completed', count: 2 }, { status: 'running', count: 1 }] };
          if (sql.includes('GROUP BY status ORDER BY status') && sql.includes('FROM agent_runs')) return { results: [{ status: 'success', count: 2 }, { status: 'timeout', count: 1 }] };
          if (sql.includes('GROUP BY provider ORDER BY provider')) return { results: [{ provider: 'tencent_eks_ci', count: 3 }] };
          if (sql.includes('recent') || sql.includes('ar.error_message')) return { results: [{ agent_run_id: 'run_timeout', task_id: 'task_timeout', provider: 'tencent_eks_ci', status: 'timeout' }] };
          throw new Error(`unexpected all SQL: ${sql}`);
        },
        async first() {
          if (sql.includes('AS deadlettered_tasks')) {
            return {
              deadlettered_tasks: 2,
              deadlettered_tasks_last_24h: 1,
              overdue_task_deadlines: 1,
              stale_agent_heartbeats: 1,
              provider_cleanup_pending: 2,
              provider_cleanup_failures: 1,
              provider_cleanup_exhausted: 1,
            };
          }
          if (sql.includes('FROM artifacts')) return { count: 3, latest_created_at: '2026-08-15T13:06:40.000Z' };
          throw new Error(`unexpected first SQL: ${sql}`);
        },
      };
    },
  },
};

const summary = await adminService.operationsSummary(env);
assert.equal(summary.generated_at, '2026-08-15T14:00:00.000Z');
assert.equal(summary.health, 'critical');
assert.equal(summary.window_hours, 24);
assert.equal(summary.thresholds.heartbeat_timeout_seconds, 600);
assert.equal(summary.agent_runs_last_24h_total, 3);
assert.equal(summary.agent_runs_last_24h_failed_or_timeout, 1);
assert.equal(summary.deadlettered_tasks, 2);
assert.equal(summary.stale_agent_heartbeats, 1);
assert.equal(summary.overdue_task_deadlines, 1);
assert.equal(summary.provider_cleanup_pending, 2);
assert.equal(summary.provider_cleanup_failures, 1);
assert.equal(summary.provider_cleanup_exhausted, 1);
assert.equal(summary.search_documents_last_24h, 3);
assert.equal(summary.recent_incidents.length, 1);
assert.ok(summary.alerts.some((alert) => alert.code === 'task_deadline_exceeded' && alert.severity === 'critical'));
assert.ok(summary.alerts.some((alert) => alert.code === 'provider_cleanup_exhausted' && alert.severity === 'critical'));
assert.ok(summary.alerts.some((alert) => alert.code === 'agent_heartbeat_stale' && alert.severity === 'warning'));
assert.ok(boundValues.includes('-600 seconds'), 'stale-heartbeat query must use the configured timeout');

console.log(JSON.stringify({
  ok: true,
  cases: ['24-hour task/run/provider counters', 'stale heartbeat threshold', 'overdue task deadline', 'cleanup pending/failure/exhaustion', 'stable alert codes', 'recent incidents', 'search document activity'],
  health: summary.health,
  alerts: summary.alerts,
  network: 'not used',
  cloud_credentials: 'not used',
}, null, 2));

function loadTsModule(relativePath, requireMap = {}) {
  const filePath = resolve(root, relativePath);
  const source = readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    exports: module.exports,
    module,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`verify-p1-observability cannot load ${specifier} from ${relativePath}`);
    },
    crypto,
    btoa,
    Date,
    URL,
  };
  vm.runInNewContext(compiled, sandbox, { filename: filePath });
  return module.exports;
}
