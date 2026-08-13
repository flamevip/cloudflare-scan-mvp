import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const baseUrl = required('STAGING_BASE_URL').replace(/\/$/, '');
const adminToken = required('STAGING_ADMIN_TOKEN');
const mode = process.argv[2] ?? 'run';
const reportPath = process.env.ACCEPTANCE_REPORT_PATH ?? 'work/staging-mock-acceptance.json';
const pollIntervalMs = clampNumber(process.env.ACCEPTANCE_POLL_INTERVAL_MS, 10_000, 1_000, 30_000);
const maxWaitMs = clampNumber(process.env.ACCEPTANCE_MAX_WAIT_MS, 5 * 60_000, 60_000, 6 * 60_000);

if (mode === 'verify-dry-run') {
  const cleanupWaitMs = clampNumber(process.env.ACCEPTANCE_CLEANUP_WAIT_MS, 0, 0, 5 * 60_000);
  const deadline = Date.now() + cleanupWaitMs;
  let instanceCount = -1;
  do {
    const preflight = await preflight();
    assert.equal(preflight.dry_run_payloads?.[0]?.dry_run_enabled, true, 'staging Worker is not back in dry-run mode');
    assert.equal(preflight.cloud_check?.ok, true, 'post-rollback Tencent read-only preflight failed');
    instanceCount = Number(preflight.cloud_check?.total_count ?? -1);
    if (instanceCount === 0) break;
    if (Date.now() >= deadline) break;
    console.log(JSON.stringify({ event: 'staging.acceptance.cleanup_wait', tencent_instance_count: instanceCount }));
    await delay(10_000);
  } while (true);
  assert.equal(instanceCount, 0, 'Tencent EKS CI instances remain after rollback');
  console.log(JSON.stringify({ event: 'staging.acceptance.rollback_verified', dry_run: true, tencent_instance_count: 0 }));
  process.exit(0);
}

assert.equal(mode, 'run', `unsupported acceptance mode: ${mode}`);
const report = {
  started_at: new Date().toISOString(),
  task_id: null,
  agent_run_id: null,
  status: 'starting',
  heartbeat_observed: false,
  artifact_count: 0,
  provider_job_id: null,
  provider_eip_id: null,
  provider_egress_ip: null,
  cleanup_completed: false,
  provider_diagnostics: null,
  provider_cleanup_attempts: 0,
  provider_cleanup_last_error: null,
};

let terminalError = null;
try {
  const before = await preflight();
  assert.equal(before.dry_run_payloads?.[0]?.dry_run_enabled, false, 'staging Worker live provider was not enabled');
  assert.equal(before.cloud_check?.ok, true, 'Tencent read-only preflight failed before acceptance');
  assert.equal(Number(before.cloud_check?.total_count ?? -1), 0, 'refusing to start: Tencent EKS CI instance list is not empty');
  await assertNoActiveTasks();

  const created = await api('/api/tasks', {
    method: 'POST',
    body: {
      project_id: 'project-default',
      name: `staging real mock acceptance ${new Date().toISOString()}`,
      targets: ['example.com'],
      modules: ['http_probe'],
      external_sources: [],
      max_agents: 1,
      rate_limit: 1,
      timeout_minutes: 5,
    },
  });
  report.task_id = created.task_id;
  console.log(JSON.stringify({ event: 'staging.acceptance.task_created', task_id: report.task_id }));

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const [task, runsResponse, cloud] = await Promise.all([
      api(`/api/tasks/${encodeURIComponent(report.task_id)}`),
      api(`/api/tasks/${encodeURIComponent(report.task_id)}/agent-runs`),
      preflight(),
    ]);
    const runs = runsResponse.items ?? [];
    assert.ok(runs.length <= 1, `single-instance invariant violated: observed ${runs.length} agent runs`);
    assert.ok(Number(cloud.cloud_check?.total_count ?? -1) <= 1, `single-instance invariant violated: Tencent reports ${cloud.cloud_check?.total_count ?? 'unknown'} instances`);
    const run = runs[0] ?? null;
    if (run) updateReportFromRun(report, run);
    report.status = task.status;
    report.artifact_count = Number(task.artifact_count ?? 0);
    console.log(JSON.stringify({
      event: 'staging.acceptance.poll',
      task_id: report.task_id,
      task_status: task.status,
      run_status: run?.status ?? null,
      heartbeat_observed: report.heartbeat_observed,
      provider_job_id: report.provider_job_id,
      provider_egress_ip: report.provider_egress_ip,
      artifact_count: report.artifact_count,
      cleanup_completed: report.cleanup_completed,
    }));
    if (task.status === 'completed') break;
    if (['failed', 'timeout', 'cancelled'].includes(task.status)) {
      terminalError = new Error(`staging acceptance task became ${task.status}: ${task.error_message ?? 'no error message'}`);
      break;
    }
    await delay(pollIntervalMs);
  }

  if (!terminalError && report.status !== 'completed') terminalError = new Error('staging acceptance exceeded the five-minute observation window');
} catch (error) {
  terminalError = error;
} finally {
  if (report.task_id && report.status !== 'completed') {
    try {
      const cancelled = await api(`/api/tasks/${encodeURIComponent(report.task_id)}/cancel`, { method: 'POST', body: {} });
      report.status = cancelled.status;
      console.log(JSON.stringify({ event: 'staging.acceptance.cancelled', task_id: report.task_id, cleanup: cancelled.cleanup }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'staging.acceptance.cancel_failed', task_id: report.task_id, error: safeError(error) }));
    }
  }

  if (report.task_id) {
    try {
      await waitForCleanup(report, 90_000);
    } catch (error) {
      terminalError ??= error;
    }
  }
  try {
    const after = await preflight();
    report.tencent_instance_count_after = Number(after.cloud_check?.total_count ?? -1);
    if (after.cloud_check?.ok !== true || report.tencent_instance_count_after !== 0) {
      terminalError ??= new Error('Tencent EKS CI instance cleanup was not confirmed');
    }
  } catch (error) {
    terminalError ??= error;
  }
  if (!terminalError) {
    try {
      assert.equal(report.status, 'completed', `acceptance task ended in unexpected status ${report.status}`);
      assert.equal(report.heartbeat_observed, true, 'Agent never sent a heartbeat');
      assert.match(report.agent_run_id ?? '', /^run_/, 'real Agent run ID was not recorded');
      assert.match(report.provider_job_id ?? '', /^eksci-/, 'real Tencent provider job ID was not recorded');
      assert.ok(report.provider_egress_ip, 'independent provider egress IP was not observed');
      assert.ok(report.artifact_count > 0, 'mock Agent produced no artifacts');
      assert.equal(report.cleanup_completed, true, 'provider cleanup did not complete');
    } catch (error) {
      terminalError = error;
    }
  }
  report.finished_at = new Date().toISOString();
  report.result = terminalError ? 'failed' : 'passed';
  report.error = terminalError ? safeError(terminalError) : null;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

if (terminalError) throw terminalError;
console.log(JSON.stringify({
  event: 'staging.acceptance.passed',
  task_id: report.task_id,
  agent_run_id: report.agent_run_id,
  provider_job_id: report.provider_job_id,
  provider_eip_id: report.provider_eip_id,
  provider_egress_ip: report.provider_egress_ip,
  artifact_count: report.artifact_count,
  tencent_instance_count_after: report.tencent_instance_count_after,
}));

async function waitForCleanup(targetReport, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api(`/api/tasks/${encodeURIComponent(targetReport.task_id)}/agent-runs`);
    const runs = response.items ?? [];
    assert.ok(runs.length <= 1, `single-instance invariant violated during cleanup: ${runs.length} runs`);
    const run = runs[0] ?? null;
    if (run) updateReportFromRun(targetReport, run);
    if (!run || targetReport.cleanup_completed) return;
    await delay(5_000);
  }
}

function updateReportFromRun(targetReport, run) {
  targetReport.agent_run_id ??= run.id ?? null;
  targetReport.heartbeat_observed ||= Boolean(run.last_heartbeat_at);
  targetReport.provider_job_id ??= run.provider_job_id ?? null;
  targetReport.provider_eip_id ??= run.provider_eip_id ?? null;
  targetReport.provider_egress_ip ??= run.provider_egress_ip ?? null;
  targetReport.cleanup_completed ||= Boolean(run.provider_cleanup_completed_at);
  targetReport.provider_cleanup_attempts = Number(run.provider_cleanup_attempts ?? targetReport.provider_cleanup_attempts ?? 0);
  targetReport.provider_cleanup_last_error = run.provider_cleanup_last_error ?? targetReport.provider_cleanup_last_error ?? null;
  targetReport.provider_diagnostics = {
    status: run.provider_status ?? null,
    container_state: run.provider_container_state ?? null,
    reason: run.provider_status_reason ?? null,
    message: run.provider_status_message ?? null,
    exit_code: run.provider_exit_code ?? null,
    events: parseJsonArray(run.provider_events_json),
    updated_at: run.provider_diagnostics_updated_at ?? null,
  };
}

async function preflight() {
  return api('/api/admin/providers/preflight', {
    method: 'POST',
    body: { provider: 'tencent_eks_ci', targets: ['example.com'], modules: ['http_probe'], rate_limit: 1, timeout_minutes: 5, cloud_check: true },
  });
}

async function assertNoActiveTasks() {
  const response = await api('/api/tasks?project_id=project-default&page=1&page_size=100');
  const activeStatuses = new Set(['pending', 'provisioning', 'retrying', 'running']);
  const active = (response.items ?? []).filter((task) => activeStatuses.has(task.status));
  assert.equal(active.length, 0, `refusing to start: staging has ${active.length} active tasks`);
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
  if (!response.ok || payload.code !== 200) throw new Error(`${options.method ?? 'GET'} ${path} failed: ${payload.message ?? response.status}`);
  return payload.data;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 600);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
