import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const state = await mkdtemp(resolve(tmpdir(), 'scan-p1-e2e-'));
const bundleDir = await mkdtemp(resolve(tmpdir(), 'scan-p1-bundle-'));
const workerBundle = resolve(bundleDir, 'worker.mjs');
const port = 8791;
const base = `http://127.0.0.1:${port}`;
let child;

try {
  // Pre-bundle once and run Wrangler with --no-bundle. Besides making the E2E
  // startup deterministic, this avoids platform-specific temporary-file
  // filters corrupting Wrangler's generated middleware source on Windows.
  await build({
    entryPoints: [resolve(root, 'worker/src/index.ts')],
    outfile: workerBundle,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
  });
  const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'scan_mvp_metadata', '--local', '--persist-to', state, '--config', 'wrangler.toml'], { cwd: root, encoding: 'utf8' });
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);

  child = spawn(process.execPath, [wrangler, 'dev', workerBundle, '--local', '--no-bundle', '--port', String(port), '--persist-to', state, '--config', 'wrangler.toml', '--var', 'AGENT_TOKEN_SECRET:fixture-agent-secret', '--var', 'TOKEN_SCOPE_ENFORCEMENT:enforce'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });
  await waitForHealth(base, child, () => serverOutput);

  const admin = 'dev-token';
  const user = await api('/api/admin/users', admin, { method: 'POST', body: { email: 'pilot-operator@example.test', role: 'reader' } });
  assert.equal(user.email, 'pilot-operator@example.test');
  await api(`/api/projects/project-default/members/${user.id}`, admin, { method: 'PUT', body: { role: 'operator', status: 'active' } });

  const createdToken = await api('/api/admin/tokens', admin, { method: 'POST', body: {
    user_id: user.id,
    name: 'pilot-e2e',
    scopes: ['tasks:read', 'tasks:write', 'artifacts:read', 'search:read'],
    expires_at: '2099-01-01T00:00:00.000Z',
  } });
  assert.match(createdToken.token, /^scan_[A-Za-z0-9_-]{40,}$/);
  const tokens = await api('/api/admin/tokens', admin);
  assert.equal(JSON.stringify(tokens).includes(createdToken.token), false, 'raw token must never appear in list response');

  const me = await api('/api/auth/me', createdToken.token);
  assert.equal(me.actor_id, user.id);
  assert.equal(me.project_roles['project-default'], 'operator');

  const task = await api('/api/tasks', createdToken.token, { method: 'POST', body: {
    name: 'pilot e2e mock',
    targets: ['example.com'],
    modules: ['subdomain', 'http_probe', 'nuclei'],
    max_agents: 1,
    rate_limit: 1,
    timeout_minutes: 5,
  } });
  const detail = await waitForTask(base, task.task_id, createdToken.token);
  assert.equal(detail.status, 'completed');
  assert.equal(Number(detail.asset_count), 1);
  assert.equal(Number(detail.artifact_count), 1);
  const completedRuns = await api(`/api/tasks/${task.task_id}/agent-runs`, createdToken.token);
  assert.ok(Number.isInteger(Number(completedRuns.items[0].duration_seconds)) && Number(completedRuns.items[0].duration_seconds) >= 0, 'completed Agent run must persist duration_seconds');

  const artifacts = await api(`/api/artifacts?task_id=${task.task_id}`, createdToken.token);
  assert.equal(artifacts.items.length, 1);
  const search = await api(`/api/search?q=example&task_id=${task.task_id}`, createdToken.token);
  assert.equal(search.degraded, true);

  const outsider = await api('/api/admin/users', admin, { method: 'POST', body: { email: 'pilot-outsider@example.test', role: 'reader' } });
  const outsiderToken = await api('/api/admin/tokens', admin, { method: 'POST', body: { user_id: outsider.id, name: 'outsider', scopes: ['tasks:read'], expires_at: '2099-01-01T00:00:00.000Z' } });
  await assert.rejects(() => api(`/api/tasks/${task.task_id}/agent-runs`, outsiderToken.token), /403/);
  const insufficientScope = await api('/api/admin/tokens', admin, { method: 'POST', body: { user_id: user.id, name: 'scope-denial', scopes: ['search:read'], expires_at: '2099-01-01T00:00:00.000Z' } });
  await assert.rejects(() => api(`/api/tasks/${task.task_id}`, insufficientScope.token), /403/);

  const rotated = await api(`/api/admin/tokens/${createdToken.id}/rotate`, admin, { method: 'POST', body: {} });
  await assert.rejects(() => api('/api/auth/me', createdToken.token), /401/);
  assert.equal((await api('/api/auth/me', rotated.token)).actor_id, user.id);
  await api(`/api/admin/tokens/${rotated.id}/revoke`, admin, { method: 'POST', body: {} });
  await assert.rejects(() => api('/api/auth/me', rotated.token), /401/);

  const retention = await api('/api/admin/maintenance/retention', admin, { method: 'POST', body: { dry_run: true } });
  assert.equal(retention.dry_run, true);
  const operations = await api('/api/admin/operations/summary', admin);
  assert.ok(Array.isArray(operations.tasks_by_status));
  const audit = await api('/api/admin/audit-logs?page_size=100', admin);
  assert.ok(audit.items.some((entry) => entry.action === 'token.rotate'));
  assert.ok(audit.items.some((entry) => entry.actor === outsider.id && entry.project_id === 'project-default' && entry.metadata_json.includes('"denied":true')));
  assert.ok(audit.items.some((entry) => entry.action === `GET /api/tasks/${task.task_id}` && entry.metadata_json.includes('"denied":true')));

  child.kill();
  await waitForExit(child);
  child = spawn(process.execPath, [wrangler, 'dev', workerBundle, '--local', '--no-bundle', '--port', String(port), '--persist-to', state, '--config', 'wrangler.toml', '--var', 'AGENT_TOKEN_SECRET:fixture-agent-secret', '--var', 'TOKEN_SCOPE_ENFORCEMENT:enforce', '--var', 'AGENT_PROVIDER:manual', '--var', 'MOCK_AGENT_MODE:manual'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverOutput = '';
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });
  await waitForHealth(base, child, () => serverOutput);
  const cancellable = await api('/api/tasks', admin, { method: 'POST', body: { name: 'cancel fixture', targets: ['example.com'], modules: ['http_probe'], rate_limit: 1, timeout_minutes: 5 } });
  await waitForTaskStatus(cancellable.task_id, admin, ['provisioning', 'running']);
  const cancelled = await api(`/api/tasks/${cancellable.task_id}/cancel`, admin, { method: 'POST', body: {} });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await api(`/api/tasks/${cancellable.task_id}`, admin)).status, 'cancelled');
  const cancelledRuns = await api(`/api/tasks/${cancellable.task_id}/agent-runs`, admin);
  assert.equal(cancelledRuns.items[0].status, 'cancelled');
  assert.ok(Number.isInteger(Number(cancelledRuns.items[0].duration_seconds)) && Number(cancelledRuns.items[0].duration_seconds) >= 0, 'cancelled Agent run must persist duration_seconds');
  assert.equal(JSON.stringify(cancelledRuns).includes('callback_token'), false);

  console.log(JSON.stringify({
    ok: true,
    task_id: task.task_id,
    final_status: detail.status,
    assets: Number(detail.asset_count),
    artifacts: Number(detail.artifact_count),
    token_plaintext_listed: false,
    rotated_token_revoked: true,
    cross_project_denial_audited: true,
    scope_denial_audited: true,
    cancelled_task_status: cancelled.status,
    duration_seconds_persisted: true,
    callback_token_exposed: false,
    retention_dry_run: retention.dry_run,
    network: 'localhost only',
    cloud_credentials: 'not used',
  }, null, 2));
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([waitForExit(child), delay(5_000)]);
  }
  await Promise.all([
    rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }),
    rm(bundleDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }),
  ]);
}

async function api(path, token, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  const parsed = JSON.parse(text);
  return parsed.data;
}

async function waitForHealth(url, processHandle, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`wrangler exited early: ${output()}`);
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {
      // Continue until Wrangler is listening.
    }
    await delay(250);
  }
  throw new Error(`wrangler did not become ready: ${output()}`);
}

async function waitForTask(url, taskId, token) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const detail = await api(`/api/tasks/${taskId}`, token);
    if (['completed', 'failed', 'timeout', 'cancelled'].includes(detail.status)) return detail;
    await delay(100);
  }
  throw new Error(`task did not reach terminal state: ${taskId}`);
}

async function waitForTaskStatus(taskId, token, statuses) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const detail = await api(`/api/tasks/${taskId}`, token);
    if (statuses.includes(detail.status)) return detail;
    if (['completed', 'failed', 'timeout', 'cancelled'].includes(detail.status)) throw new Error(`task reached unexpected terminal status ${detail.status}`);
    await delay(100);
  }
  throw new Error(`task did not reach ${statuses.join('/')}: ${taskId}`);
}

function waitForExit(processHandle) {
  if (processHandle.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => processHandle.once('exit', resolveExit));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
