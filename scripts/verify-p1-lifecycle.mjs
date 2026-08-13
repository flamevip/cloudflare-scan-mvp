import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const preparedSql = [];
let firstTransitionChanges = 1;
const env = {
  DB: {
    prepare(sql) {
      preparedSql.push(sql);
      return { bind() { return this; } };
    },
    async batch(statements) {
      return statements.map((_statement, index) => ({ success: true, meta: { changes: index === 0 ? firstTransitionChanges : 1 } }));
    },
  },
};
const stateMachine = loadTsModule('worker/src/services/state-machine.ts', {
  '../ids': { nowIso: () => '2026-08-11T00:00:00.000Z' },
});

assert.equal(await stateMachine.markCompleted(env, 'task-1', 'shard-1', 'run-1'), true);
firstTransitionChanges = 0;
assert.equal(await stateMachine.markCompleted(env, 'task-1', 'shard-1', 'run-1'), false, 'losing terminal transition must be observable by caller');
assert.ok(preparedSql.some((sql) => sql.includes("status IN ('starting', 'running')") && sql.includes('EXISTS (SELECT 1 FROM tasks')));
assert.ok(preparedSql.some((sql) => sql.includes("status = 'completed'") && sql.includes('dispatch_claim = NULL')));

const consumer = source('worker/src/queue/consumer.ts');
const taskService = source('worker/src/services/task-service.ts');
const timeoutService = source('worker/src/services/timeout-service.ts');
const ingestService = source('worker/src/services/ingest-service.ts');
const agentRoute = source('worker/src/routes/agent.ts');
const adminService = source('worker/src/services/admin-service.ts');
const indexSource = source('worker/src/index.ts');
const queueTypes = source('worker/src/types/queue.ts');

assert.match(consumer, /UPDATE tasks SET status = 'provisioning', dispatch_claim = \?/);
assert.match(consumer, /NOT EXISTS \([\s\S]*task_shards[\s\S]*status IN \('provisioning', 'running'\)/);
assert.match(consumer, /recordLateProviderLaunchAndCleanup/);
assert.match(consumer, /provider_cleanup_completed_at = NULL/);
assert.match(taskService, /UPDATE tasks SET status = 'cancelled', dispatch_claim = NULL/);
assert.match(taskService, /if \(Number\(results\[0\]\?\.meta\?\.changes/);
assert.match(taskService, /pilot tasks require the fixed subdomain \+ http_probe \+ nuclei toolchain/);
assert.match(taskService, /pilot tasks require rate_limit=1/);
assert.match(taskService, /pilot tasks require timeout_minutes <= 15/);
assert.match(timeoutService, /isTaskDeadlineExceeded/);
assert.match(timeoutService, /retryable: !totalDeadlineExceeded/);
assert.match(timeoutService, /if \(!transitioned\) continue/);
assert.match(ingestService, /ar\.status IN \('starting', 'running'\)/);
assert.match(ingestService, /t\.status NOT IN \('completed', 'failed', 'timeout', 'cancelled'\)/);
assert.match(ingestService, /ingest\.orphan_cleanup\.failed/);
assert.match(agentRoute, /agent run became terminal before completion/);
assert.match(adminService, /rotation_claim = \?/);
assert.match(adminService, /token was rotated or revoked concurrently/);
assert.match(consumer, /QueueProviderModeMismatchError/);
assert.match(consumer, /message\.required_provider_mode !== actual/);
assert.match(indexSource, /message\.retry\(\{ delaySeconds: 5 \}\)/);
assert.match(queueTypes, /type: 'deployment\.canary'/);

console.log(JSON.stringify({ ok: true, terminal_compare_and_set: true, duplicate_dispatch_claim: true, cancel_race_guard: true, total_deadline: true, late_provider_launch_cleanup: true, late_ingest_guard: true, token_rotation_claim: true, network: 'not used', cloud_credentials: 'not used' }, null, 2));

function source(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
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
      throw new Error(`verify-p1-lifecycle cannot load ${specifier}`);
    },
  }, { filename: filePath });
  return module.exports;
}
