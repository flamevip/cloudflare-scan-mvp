import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const baseUrl = required('STAGING_BASE_URL').replace(/\/$/, '');
const adminToken = required('STAGING_ADMIN_TOKEN');
const scenario = process.argv[2];
assert.ok(['cancel', 'timeout'].includes(scenario), `unsupported negative acceptance scenario: ${scenario}`);

const reportPath = process.env.ACCEPTANCE_REPORT_PATH ?? `work/staging-${scenario}-acceptance.json`;
const pollIntervalMs = clampNumber(process.env.ACCEPTANCE_POLL_INTERVAL_MS, 1_000, 500, 10_000);
const launchWaitMs = clampNumber(process.env.ACCEPTANCE_LAUNCH_WAIT_MS, 3 * 60_000, 60_000, 5 * 60_000);
const cleanupWaitMs = clampNumber(process.env.ACCEPTANCE_CLEANUP_WAIT_MS, 2 * 60_000, 30_000, 5 * 60_000);

const report = {
  scenario,
  started_at: new Date().toISOString(),
  task_id: null,
  agent_run_id: null,
  task_status: 'starting',
  run_status: null,
  provider_job_id: null,
  provider_eip_id: null,
  provider_egress_ip: null,
  heartbeat_observed: false,
  artifact_count: 0,
  cleanup_completed: false,
  provider_cleanup_attempts: 0,
  provider_cleanup_last_error: null,
  max_tencent_instance_count: 0,
  tencent_instance_count_after: null,
  duplicate_cancel_idempotent: false,
  timeout_sweeps: [],
};

let terminalError = null;
try {
  const before = await getPreflight();
  assert.equal(before.dry_run_payloads?.[0]?.dry_run_enabled, false, 'staging Worker live provider was not enabled');
  assert.equal(before.cloud_check?.ok, true, 'Tencent read-only preflight failed before negative acceptance');
  assert.equal(Number(before.cloud_check?.total_count ?? -1), 0, 'refusing to start: Tencent EKS CI instance list is not empty');
  await assertNoActiveTasks();

  const created = await api('/api/tasks', {
    method: 'POST',
    body: {
      project_id: 'project-default',
      name: `staging ${scenario} acceptance ${new Date().toISOString()}`,
      targets: ['example.com'],
      modules: ['http_probe'],
      external_sources: [],
      max_agents: 1,
      rate_limit: 1,
      timeout_minutes: scenario === 'timeout' ? 1 : 5,
    },
  });
  report.task_id = created.task_id;
  console.log(JSON.stringify({ event: 'staging.negative.task_created', scenario, task_id: report.task_id }));

  await waitForRealProviderLaunch(report, launchWaitMs);
  assert.match(report.provider_job_id ?? '', /^eksci-/, 'real Tencent provider job ID was not recorded');

  if (scenario === 'cancel') {
    const cancelled = await api(`/api/tasks/${encodeURIComponent(report.task_id)}/cancel`, { method: 'POST', body: {} });
    assert.equal(cancelled.status, 'cancelled', 'cancel API did not return cancelled');
    report.task_status = cancelled.status;
    console.log(JSON.stringify({ event: 'staging.negative.cancel_requested', task_id: report.task_id, cleanup: cancelled.cleanup }));

    const duplicate = await api(`/api/tasks/${encodeURIComponent(report.task_id)}/cancel`, { method: 'POST', body: {} });
    assert.equal(duplicate.status, 'cancelled');
    assert.equal(duplicate.already_cancelled, true, 'duplicate cancellation was not idempotent');
    report.duplicate_cancel_idempotent = true;

    await waitForTerminalAndCleanup(report, 'cancelled', cleanupWaitMs);
    await delay(15_000);
    const afterLateCallbackWindow = await api(`/api/tasks/${encodeURIComponent(report.task_id)}`);
    report.task_status = afterLateCallbackWindow.status;
    report.artifact_count = Number(afterLateCallbackWindow.artifact_count ?? 0);
    assert.equal(report.task_status, 'cancelled', 'task changed state after cancellation');
    assert.equal(report.artifact_count, 0, 'cancelled task accepted artifacts after cancellation');
  } else {
    const timeoutDeadline = Date.now() + 2 * 60_000;
    while (Date.now() < timeoutDeadline) {
      await delay(5_000);
      const sweep = await api('/api/admin/maintenance/timeouts', { method: 'POST', body: {} });
      report.timeout_sweeps.push(sweep);
      const task = await api(`/api/tasks/${encodeURIComponent(report.task_id)}`);
      report.task_status = task.status;
      report.artifact_count = Number(task.artifact_count ?? 0);
      console.log(JSON.stringify({ event: 'staging.negative.timeout_poll', task_id: report.task_id, task_status: task.status, sweep }));
      if (task.status === 'timeout') break;
      if (['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error(`timeout task became ${task.status}`);
    }
    assert.equal(report.task_status, 'timeout', 'task was not transitioned to timeout');
    assert.equal(report.heartbeat_observed, false, 'no-callback timeout fixture unexpectedly sent a heartbeat');
    assert.ok(report.timeout_sweeps.some((item) => Number(item.timed_out ?? 0) >= 1), 'timeout maintenance never claimed the Agent run');
    await waitForTerminalAndCleanup(report, 'timeout', cleanupWaitMs);
    const idempotentSweep = await api('/api/admin/maintenance/timeouts', { method: 'POST', body: {} });
    report.timeout_sweeps.push(idempotentSweep);
    assert.equal(Number(idempotentSweep.timed_out ?? -1), 0, 'repeated timeout sweep was not idempotent');
  }

  const after = await getPreflight();
  report.tencent_instance_count_after = Number(after.cloud_check?.total_count ?? -1);
  assert.equal(after.cloud_check?.ok, true, 'Tencent read-only preflight failed after negative acceptance');
  assert.equal(report.tencent_instance_count_after, 0, 'Tencent EKS CI instances remain after negative acceptance');
  assert.equal(report.cleanup_completed, true, 'provider cleanup did not complete');
} catch (error) {
  terminalError = error;
} finally {
  if (report.task_id) {
    try {
      const task = await api(`/api/tasks/${encodeURIComponent(report.task_id)}`);
      if (!['completed', 'failed', 'timeout', 'cancelled'].includes(task.status)) {
        const cancelled = await api(`/api/tasks/${encodeURIComponent(report.task_id)}/cancel`, { method: 'POST', body: {} });
        report.task_status = cancelled.status;
        console.log(JSON.stringify({ event: 'staging.negative.safety_cancel', task_id: report.task_id, cleanup: cancelled.cleanup }));
      }
      await waitForAnyCleanup(report, cleanupWaitMs);
    } catch (error) {
      terminalError ??= error;
    }
  }
  try {
    const after = await getPreflight();
    report.tencent_instance_count_after = Number(after.cloud_check?.total_count ?? -1);
    if (after.cloud_check?.ok !== true || report.tencent_instance_count_after !== 0) {
      terminalError ??= new Error('Tencent EKS CI instance cleanup was not confirmed');
    }
  } catch (error) {
    terminalError ??= error;
  }
  report.finished_at = new Date().toISOString();
  report.result = terminalError ? 'failed' : 'passed';
  report.error = terminalError ? safeError(terminalError) : null;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

if (terminalError) throw terminalError;
console.log(JSON.stringify({
  event: 'staging.negative.passed',
  scenario,
  task_id: report.task_id,
  agent_run_id: report.agent_run_id,
  provider_job_id: report.provider_job_id,
  provider_egress_ip: report.provider_egress_ip,
  task_status: report.task_status,
  tencent_instance_count_after: report.tencent_instance_count_after,
}));

async function waitForRealProviderLaunch(targetReport, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [task, runsResponse, cloud] = await Promise.all([
      api(`/api/tasks/${encodeURIComponent(targetReport.task_id)}`),
      api(`/api/tasks/${encodeURIComponent(targetReport.task_id)}/agent-runs`),
      getPreflight(),
    ]);
    const runs = runsResponse.items ?? [];
    assert.ok(runs.length <= 1, `single-instance invariant violated: observed ${runs.length} Agent runs`);
    const instanceCount = Number(cloud.cloud_check?.total_count ?? -1);
    assert.ok(instanceCount <= 1, `single-instance invariant violated: Tencent reports ${instanceCount} instances`);
    targetReport.max_tencent_instance_count = Math.max(targetReport.max_tencent_instance_count, instanceCount);
    targetReport.task_status = task.status;
    targetReport.artifact_count = Number(task.artifact_count ?? 0);
    const run = runs[0] ?? null;
    if (run) updateReportFromRun(targetReport, run);
    console.log(JSON.stringify({
      event: 'staging.negative.launch_poll',
      scenario,
      task_status: task.status,
      run_status: run?.status ?? null,
      provider_job_id: run?.provider_job_id ?? null,
      tencent_instance_count: instanceCount,
    }));
    if (run?.provider_job_id?.startsWith('eksci-')) return;
    if (['completed', 'failed', 'timeout', 'cancelled'].includes(task.status)) throw new Error(`task became ${task.status} before a real provider launch was observed`);
    await delay(pollIntervalMs);
  }
  throw new Error('real Tencent provider launch was not observed before deadline');
}

async function waitForTerminalAndCleanup(targetReport, expectedStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [task, runsResponse, cloud] = await Promise.all([
      api(`/api/tasks/${encodeURIComponent(targetReport.task_id)}`),
      api(`/api/tasks/${encodeURIComponent(targetReport.task_id)}/agent-runs`),
      getPreflight(),
    ]);
    targetReport.task_status = task.status;
    targetReport.artifact_count = Number(task.artifact_count ?? 0);
    const runs = runsResponse.items ?? [];
    assert.ok(runs.length <= 1, `single-instance invariant violated during cleanup: ${runs.length} Agent runs`);
    if (runs[0]) updateReportFromRun(targetReport, runs[0]);
    const instanceCount = Number(cloud.cloud_check?.total_count ?? -1);
    targetReport.max_tencent_instance_count = Math.max(targetReport.max_tencent_instance_count, instanceCount);
    if (task.status === expectedStatus && targetReport.cleanup_completed && instanceCount === 0) return;
    if (task.status !== expectedStatus && ['completed', 'failed', 'timeout', 'cancelled'].includes(task.status)) {
      throw new Error(`expected task status ${expectedStatus}, observed ${task.status}`);
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`cleanup did not converge for ${expectedStatus} task`);
}

async function waitForAnyCleanup(targetReport, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [runsResponse, cloud] = await Promise.all([
      api(`/api/tasks/${encodeURIComponent(targetReport.task_id)}/agent-runs`),
      getPreflight(),
    ]);
    const run = (runsResponse.items ?? [])[0] ?? null;
    if (run) updateReportFromRun(targetReport, run);
    const count = Number(cloud.cloud_check?.total_count ?? -1);
    if ((!run || targetReport.cleanup_completed) && count === 0) return;
    await delay(2_000);
  }
}

function updateReportFromRun(targetReport, run) {
  targetReport.agent_run_id ??= run.id ?? null;
  targetReport.run_status = run.status ?? targetReport.run_status;
  targetReport.provider_job_id ??= run.provider_job_id ?? null;
  targetReport.provider_eip_id ??= run.provider_eip_id ?? null;
  targetReport.provider_egress_ip ??= run.provider_egress_ip ?? null;
  targetReport.heartbeat_observed ||= Boolean(run.last_heartbeat_at);
  targetReport.cleanup_completed ||= Boolean(run.provider_cleanup_completed_at);
  targetReport.provider_cleanup_attempts = Number(run.provider_cleanup_attempts ?? targetReport.provider_cleanup_attempts ?? 0);
  targetReport.provider_cleanup_last_error = run.provider_cleanup_last_error ?? targetReport.provider_cleanup_last_error ?? null;
}

async function getPreflight() {
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

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 600);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
