import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const baseUrl = required('PILOT_BASE_URL').replace(/\/$/, '');
const adminToken = required('PILOT_ADMIN_TOKEN');
const target = required('PILOT_TARGET').toLowerCase();
const approvalReference = required('APPROVAL_REFERENCE');
const mode = process.argv[2] ?? 'run';
const reportPath = process.env.ACCEPTANCE_REPORT_PATH ?? 'work/pilot-acceptance.json';
const pollIntervalMs = clampNumber(process.env.ACCEPTANCE_POLL_INTERVAL_MS, 10_000, 2_000, 30_000);
const maxWaitMs = clampNumber(process.env.ACCEPTANCE_MAX_WAIT_MS, 18 * 60_000, 60_000, 20 * 60_000);

assert.equal(target, '70yun.xyz', 'this protected Pilot workflow is restricted to 70yun.xyz');
assert.match(approvalReference, /^PILOT-\d{8}-\d{3}$/, 'invalid Pilot approval reference');

if (mode === 'preflight') {
  await waitForProviderMode(true);
  const preflight = await getPreflight();
  assertPreflight(preflight, true);
  assert.equal(Number(preflight.cloud_check?.total_count ?? -1), 0, 'refusing to proceed: Tencent EKS CI instance list is not empty');
  await waitForStableZeroInstances(30_000, true, 'pilot.acceptance.preflight_stability');
  await assertNoActiveTasks();
  const search = await api('/api/admin/search/status');
  assert.equal(search.enabled, true, 'AI Search is not enabled');
  assert.equal(search.binding_present, true, 'AI Search binding is missing');
  console.log(JSON.stringify({ event: 'pilot.acceptance.preflight_passed', target, tencent_instance_count: 0, search_binding_present: true }));
  process.exit(0);
}

if (mode === 'verify-live-consumer') {
  await waitForProviderMode(false);
  await verifyConsumerCanary(false);
  const preflight = await getPreflight();
  assertPreflight(preflight, false);
  assert.equal(Number(preflight.cloud_check?.total_count ?? -1), 0, 'refusing to create Pilot task while an EKS CI instance exists');
  await waitForStableZeroInstances(30_000, false, 'pilot.acceptance.live_consumer_stability');
  console.log(JSON.stringify({ event: 'pilot.acceptance.live_consumer_verified', target }));
  process.exit(0);
}

if (mode === 'verify-dry-run') {
  await waitForProviderMode(true);
  await waitForStableZeroInstances(5 * 60_000, true, 'pilot.acceptance.cleanup_wait');
  await verifyConsumerCanary(true);
  console.log(JSON.stringify({ event: 'pilot.acceptance.rollback_verified', dry_run: true, tencent_instance_count: 0 }));
  process.exit(0);
}

assert.equal(mode, 'run', `unsupported Pilot acceptance mode: ${mode}`);

const report = {
  approval_reference: approvalReference,
  target,
  started_at: new Date().toISOString(),
  task_id: null,
  agent_run_id: null,
  status: 'starting',
  heartbeat_observed: false,
  provider_job_id: null,
  provider_eip_id: null,
  provider_egress_ip: null,
  duration_seconds: null,
  asset_count: 0,
  asset_hosts: [],
  finding_count: 0,
  artifact_count: 0,
  artifact_types: [],
  stages: [],
  search_degraded: null,
  search_items: 0,
  cleanup_completed: false,
  provider_cleanup_attempts: 0,
  provider_cleanup_last_error: null,
  provider_diagnostics: null,
};

let terminalError = null;
try {
  const before = await getPreflight();
  assertPreflight(before, false);
  assert.equal(Number(before.cloud_check?.total_count ?? -1), 0, 'refusing to start: Tencent EKS CI instance list is not empty');
  await waitForStableZeroInstances(30_000, false, 'pilot.acceptance.pre_task_stability');
  await assertNoActiveTasks();

  const created = await api('/api/tasks', {
    method: 'POST',
    body: {
      project_id: 'project-default',
      name: `authorized Pilot ${target} ${approvalReference}`,
      targets: [target],
      target_urls: [`https://${target}:443/`],
      modules: ['subdomain', 'http_probe', 'nuclei'],
      external_sources: [],
      max_agents: 1,
      rate_limit: 1,
      timeout_minutes: 15,
      max_cost_usd: 0.7,
    },
  });
  report.task_id = created.task_id;
  console.log(JSON.stringify({ event: 'pilot.acceptance.task_created', task_id: report.task_id, target }));

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const [task, runsResponse, preflight] = await Promise.all([
      api(`/api/tasks/${encodeURIComponent(report.task_id)}`),
      api(`/api/tasks/${encodeURIComponent(report.task_id)}/agent-runs`),
      getPreflight(),
    ]);
    const runs = runsResponse.items ?? [];
    assert.ok(runs.length <= 1, `single-Agent invariant violated: observed ${runs.length} Agent runs`);
    assert.ok(Number(preflight.cloud_check?.total_count ?? -1) <= 1, `single-instance invariant violated: Tencent reports ${preflight.cloud_check?.total_count ?? 'unknown'} instances`);
    const run = runs[0] ?? null;
    if (run) updateReportFromRun(report, run);
    assert.ok(!run?.provider_job_id?.startsWith('dry-run:'), 'live Pilot task was consumed by a dry-run Queue version');
    report.status = task.status;
    report.asset_count = Number(task.asset_count ?? 0);
    report.finding_count = Number(task.finding_count ?? 0);
    report.artifact_count = Number(task.artifact_count ?? 0);
    console.log(JSON.stringify({
      event: 'pilot.acceptance.poll',
      task_id: report.task_id,
      task_status: task.status,
      run_status: run?.status ?? null,
      heartbeat_observed: report.heartbeat_observed,
      provider_egress_ip: report.provider_egress_ip,
      asset_count: report.asset_count,
      finding_count: report.finding_count,
      artifact_count: report.artifact_count,
      cleanup_completed: report.cleanup_completed,
    }));
    if (task.status === 'completed') break;
    if (['failed', 'timeout', 'cancelled'].includes(task.status)) {
      throw new Error(`Pilot task became ${task.status}: ${task.error_message ?? 'no error message'}`);
    }
    await delay(pollIntervalMs);
  }
  if (report.status !== 'completed') throw new Error('Pilot task exceeded the 18-minute observation window');

  await validateResults(report);
  await waitForCleanup(report, 2 * 60_000);
  assert.equal(report.cleanup_completed, true, 'provider cleanup did not complete');
  await waitForStableZeroInstances(2 * 60_000, false, 'pilot.acceptance.post_task_cleanup_wait');
} catch (error) {
  terminalError = error;
} finally {
  if (report.task_id && !['completed', 'cancelled'].includes(report.status)) {
    try {
      const cancelled = await api(`/api/tasks/${encodeURIComponent(report.task_id)}/cancel`, { method: 'POST', body: {} });
      report.status = cancelled.status;
      console.log(JSON.stringify({ event: 'pilot.acceptance.cancelled', task_id: report.task_id }));
      await waitForCleanup(report, 2 * 60_000);
    } catch (error) {
      console.error(JSON.stringify({ event: 'pilot.acceptance.cancel_failed', task_id: report.task_id, error: safeError(error) }));
    }
  }
  report.finished_at = new Date().toISOString();
  report.result = terminalError ? 'failed' : 'passed';
  report.error = terminalError ? safeError(terminalError) : null;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

if (terminalError) throw terminalError;
console.log(JSON.stringify({
  event: 'pilot.acceptance.passed',
  task_id: report.task_id,
  agent_run_id: report.agent_run_id,
  provider_job_id: report.provider_job_id,
  provider_eip_id: report.provider_eip_id,
  provider_egress_ip: report.provider_egress_ip,
  duration_seconds: report.duration_seconds,
  asset_count: report.asset_count,
  asset_hosts: report.asset_hosts,
  finding_count: report.finding_count,
  artifact_count: report.artifact_count,
  stages: report.stages.map((stage) => ({ name: stage.name, status: stage.status, duration_ms: stage.duration_ms })),
  search_degraded: report.search_degraded,
  search_items: report.search_items,
  tencent_instance_count_after: 0,
}));

async function validateResults(targetReport) {
  const [assetsResponse, findingsResponse, artifactsResponse] = await Promise.all([
    api(`/api/assets?task_id=${encodeURIComponent(targetReport.task_id)}`),
    api(`/api/findings?task_id=${encodeURIComponent(targetReport.task_id)}`),
    api(`/api/artifacts?task_id=${encodeURIComponent(targetReport.task_id)}`),
  ]);
  const assets = assetsResponse.items ?? [];
  const findings = findingsResponse.items ?? [];
  const artifacts = artifactsResponse.items ?? [];
  targetReport.asset_count = assets.length;
  targetReport.asset_hosts = [...new Set(assets.map((asset) => String(asset.host ?? '').trim().toLowerCase()).filter(Boolean))].sort();
  targetReport.finding_count = findings.length;
  targetReport.artifact_count = artifacts.length;
  targetReport.artifact_types = [...new Set(artifacts.map((artifact) => artifact.type))];
  assert.ok(assets.length >= 1, 'Pilot produced no HTTP assets');
  assert.ok(targetReport.asset_hosts.length >= 1, 'Pilot HTTP assets had no host');
  assert.ok(
    targetReport.asset_hosts.every((host) => host === target || host.endsWith(`.${target}`)),
    'httpx result escaped authorized root scope',
  );
  const rawArtifact = artifacts.find((artifact) => artifact.type === 'agent_real_toolchain_raw');
  assert.ok(rawArtifact, 'real toolchain raw artifact is missing');
  assert.ok(rawArtifact.search_r2_key, 'search document R2 key is missing');

  const rawResponse = await apiRaw(`/api/artifacts/${encodeURIComponent(rawArtifact.id)}/download`);
  const records = rawResponse.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const stages = records.filter((record) => record.source === 'tool-stage');
  targetReport.stages = stages;
  for (const stageName of ['subfinder', 'httpx', 'nuclei']) {
    const stage = stages.find((item) => item.name === stageName);
    assert.ok(stage, `${stageName} stage record is missing`);
    assert.ok(Number.isFinite(Number(stage.duration_ms)), `${stageName} duration_ms is missing`);
    assert.ok(stage.exit_code === null || Number.isInteger(Number(stage.exit_code)), `${stageName} exit_code is invalid`);
  }
  const httpx = stages.find((item) => item.name === 'httpx');
  assert.ok(Number(httpx.input_count ?? 0) >= 1, 'httpx received no authorized candidates');

  const search = await api(`/api/search?q=${encodeURIComponent(target)}&task_id=${encodeURIComponent(targetReport.task_id)}`);
  targetReport.search_degraded = search.degraded;
  targetReport.search_items = (search.items ?? []).length;
  assert.equal(search.degraded, false, `AI Search query degraded: ${search.error?.message ?? 'unknown error'}`);
  assert.ok(targetReport.duration_seconds !== null && Number.isFinite(Number(targetReport.duration_seconds)), 'Agent run duration_seconds is missing');
  assert.ok(targetReport.provider_egress_ip, 'independent provider egress IP was not recorded');
}

async function waitForStableZeroInstances(timeoutMs, expectedDryRun, event) {
  const deadline = Date.now() + timeoutMs;
  let consecutiveZero = 0;
  let instanceCount = -1;
  while (Date.now() < deadline) {
    const preflight = await getPreflight();
    assertPreflight(preflight, expectedDryRun);
    instanceCount = Number(preflight.cloud_check?.total_count ?? -1);
    consecutiveZero = instanceCount === 0 ? consecutiveZero + 1 : 0;
    console.log(JSON.stringify({ event, tencent_instance_count: instanceCount, consecutive_zero_observations: consecutiveZero }));
    if (consecutiveZero >= 3) return;
    await delay(5_000);
  }
  throw new Error(`Tencent EKS CI cleanup was not stable: count=${instanceCount}, consecutive_zero_observations=${consecutiveZero}`);
}

function assertPreflight(preflight, expectedDryRun) {
  assert.equal(preflight.provider, 'tencent_eks_ci');
  assert.equal(preflight.dry_run_payloads?.[0]?.dry_run_enabled, expectedDryRun, `provider is not in expected ${expectedDryRun ? 'dry-run' : 'live'} mode`);
  assert.equal(preflight.dry_run_payloads?.[0]?.required_config?.missing?.length ?? -1, 0, 'Tencent provider configuration is incomplete');
  assert.equal(preflight.dry_run_payloads?.[0]?.provider_config_summary?.image_digest_pinned, true, 'Agent image is not pinned by digest');
  assert.equal(preflight.cloud_check?.ok, true, 'Tencent read-only Provider preflight failed');
}

async function getPreflight() {
  return api('/api/admin/providers/preflight', {
    method: 'POST',
    body: {
      provider: 'tencent_eks_ci',
      targets: [target],
      target_urls: [`https://${target}:443/`],
      modules: ['subdomain', 'http_probe', 'nuclei'],
      rate_limit: 1,
      timeout_minutes: 15,
      max_cost_usd: 0.7,
      cloud_check: true,
    },
  });
}

async function waitForProviderMode(expectedDryRun) {
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    const preflight = await getPreflight();
    last = preflight.dry_run_payloads?.[0]?.dry_run_enabled;
    if (last === expectedDryRun) return;
    await delay(3_000);
  }
  throw new Error(`Pilot Worker did not converge to ${expectedDryRun ? 'dry-run' : 'live'} mode; observed=${last}`);
}

async function assertNoActiveTasks() {
  const response = await api('/api/tasks?project_id=project-default&page=1&page_size=100');
  const activeStatuses = new Set(['pending', 'provisioning', 'retrying', 'running']);
  const active = (response.items ?? []).filter((task) => activeStatuses.has(task.status));
  assert.equal(active.length, 0, `refusing to start: Pilot has ${active.length} active tasks`);
}

async function verifyConsumerCanary(expectedDryRun) {
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    const queued = await api('/api/admin/providers/consumer-canary', { method: 'POST', body: {} });
    const attemptDeadline = Math.min(deadline, Date.now() + 15_000);
    while (Date.now() < attemptDeadline) {
      const query = new URLSearchParams({ action: 'queue.consumer.canary', entity_id: queued.nonce, page: '1', page_size: '1' });
      const response = await api(`/api/admin/audit-logs?${query}`);
      const item = response.items?.[0];
      if (item) {
        const metadata = parseJsonObject(item.metadata_json);
        last = metadata.tencent_dry_run_enabled === true;
        if (last === expectedDryRun) return;
        break;
      }
      await delay(1_000);
    }
    await delay(2_000);
  }
  throw new Error(`Queue consumer did not converge to ${expectedDryRun ? 'dry-run' : 'live'} mode; observed=${last}`);
}

async function waitForCleanup(targetReport, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api(`/api/tasks/${encodeURIComponent(targetReport.task_id)}/agent-runs`);
    const runs = response.items ?? [];
    assert.ok(runs.length <= 1, `single-Agent invariant violated during cleanup: ${runs.length}`);
    if (runs[0]) updateReportFromRun(targetReport, runs[0]);
    if (!runs[0] || targetReport.cleanup_completed) return;
    await delay(5_000);
  }
}

function updateReportFromRun(targetReport, run) {
  targetReport.agent_run_id ??= run.id ?? null;
  targetReport.heartbeat_observed ||= Boolean(run.last_heartbeat_at);
  targetReport.provider_job_id ??= run.provider_job_id ?? null;
  targetReport.provider_eip_id ??= run.provider_eip_id ?? null;
  targetReport.provider_egress_ip ??= run.provider_egress_ip ?? null;
  targetReport.duration_seconds = run.duration_seconds ?? targetReport.duration_seconds;
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

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: { Authorization: `Bearer ${adminToken}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const payload = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
  if (!response.ok || payload.code !== 200) throw new Error(`${options.method ?? 'GET'} ${path} failed: ${payload.message ?? response.status}`);
  return payload.data;
}

async function apiRaw(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`GET ${path} failed: HTTP ${response.status}`);
  return response.text();
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
  try { const parsed = JSON.parse(value ?? '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function parseJsonObject(value) {
  try { const parsed = JSON.parse(value ?? '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 800);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
