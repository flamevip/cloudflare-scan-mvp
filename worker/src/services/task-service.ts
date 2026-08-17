import type { Env } from '../env';
import type { CreateTaskRequest } from '../types/api';
import type { ScanDispatchMessage } from '../types/queue';
import { assertProjectRead, assertProjectWrite, defaultProjectId, projectFilter, type AuthContext } from '../auth';
import { newId, nowIso } from '../ids';
import { HttpError } from '../response';
import {
  DEFAULT_MAX_AGENTS,
  DEFAULT_RATE_LIMIT,
  DEFAULT_TIMEOUT_MINUTES,
  MAX_MAX_AGENTS,
  MAX_RATE_LIMIT,
  MAX_TIMEOUT_MINUTES,
  MIN_MAX_AGENTS,
  MIN_RATE_LIMIT,
  MIN_TIMEOUT_MINUTES,
  normalizeExternalSources,
  normalizeScanModules,
  type AgentConfigContract,
} from '../contracts';
import { configKey, putJson, putText, targetCandidatesKey, targetsKey } from './r2-service';
import { parseProjectScope, validateTargets, validateTargetUrls } from './scope-validation';
import { processDispatchMessage } from '../queue/consumer';
import { resolveEffectiveAgentProvider } from './agent-provider';
import { cleanupProviderRunAndSchedule } from './provider-cleanup-service';
import { writeAudit } from './audit-service';
import { isTencentEksCiDryRun } from './tencent-eks-ci-service';

interface TaskProjectRow {
  id: string;
  project_id: string;
}

interface CancellableRunRow {
  id: string;
  task_id: string;
  provider: string;
  provider_job_id: string | null;
  provider_cleanup_attempts: number;
}

interface ProjectRow {
  id: string;
  scope_json: string;
}

export async function createTask(env: Env, context: AuthContext, body: CreateTaskRequest): Promise<{ task_id: string; status: string }> {
  const projectId = body.project_id?.trim() || defaultProjectId(env);
  assertProjectWrite(context, projectId);
  const allowedRoots = await loadProjectScope(env, context, projectId);
  const targets = validateTargets(body.targets, allowedRoots);
  const targetUrls = validateTargetUrls(body.target_urls, allowedRoots, targets);
  const modules = parseContractValue(() => normalizeScanModules(body.modules));
  const externalSources = parseContractValue(() => normalizeExternalSources(body.external_sources));
  const maxAgents = clampNumber(body.max_agents, DEFAULT_MAX_AGENTS, MIN_MAX_AGENTS, MAX_MAX_AGENTS);
  const rateLimit = clampNumber(body.rate_limit, DEFAULT_RATE_LIMIT, MIN_RATE_LIMIT, MAX_RATE_LIMIT);
  const timeoutMinutes = clampNumber(body.timeout_minutes, DEFAULT_TIMEOUT_MINUTES, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES);
  const maxCostUsd = optionalPositiveNumber(body.max_cost_usd);
  assertPilotTaskPolicy(env, targets, modules, externalSources, maxAgents, rateLimit, timeoutMinutes);
  const taskId = newId('task');
  const now = nowIso();
  const name = body.name?.trim() || `${targets.join(', ')} scan`;
  const cfgKey = configKey(taskId);
  const tgtKey = targetsKey(taskId);

  const config: AgentConfigContract = {
    task_id: taskId,
    project_id: projectId,
    modules,
    external_sources: externalSources,
    max_agents: maxAgents,
    rate_limit: rateLimit,
    timeout_minutes: timeoutMinutes,
    max_cost_usd: maxCostUsd,
    target_url_count: targetUrls.length,
    created_at: now,
  };

  await env.DB.prepare(`
    INSERT INTO tasks (id, project_id, name, status, targets_json, modules_json, external_sources_json, target_count, max_agents, rate_limit, timeout_minutes, max_cost_usd, created_by, config_r2_key, targets_r2_key, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(taskId, projectId, name, JSON.stringify(targets), JSON.stringify(modules), JSON.stringify(externalSources), targets.length, maxAgents, rateLimit, timeoutMinutes, maxCostUsd, context.actor_id, cfgKey, tgtKey, now, now).run();

  await putJson(env, cfgKey, config);
  await putText(env, tgtKey, `${targets.join('\n')}\n`);
  if (targetUrls.length) await putText(env, targetCandidatesKey(taskId), `${targetUrls.join('\n')}\n`);

  const message: ScanDispatchMessage = {
    type: 'task.created',
    task_id: taskId,
    project_id: projectId,
    config_r2_key: cfgKey,
    targets_r2_key: tgtKey,
    attempt: 1,
    created_at: now,
    ...(resolveEffectiveAgentProvider(env) === 'tencent_eks_ci'
      ? { required_provider_mode: isTencentEksCiDryRun(env.TENCENT_EKS_CI_DRY_RUN) ? 'dry_run' as const : 'live' as const }
      : {}),
  };
  await env.SCAN_DISPATCH.send(message);
  await writeAudit(env, { actor: context.actor_id, action: 'task.create', entity_type: 'task', entity_id: taskId, project_id: projectId, metadata: { targets, target_url_count: targetUrls.length, modules, max_cost_usd: maxCostUsd } });

  if (resolveEffectiveAgentProvider(env) === 'mock_inline') {
    await processDispatchMessage(env, message);
  }

  return { task_id: taskId, status: 'pending' };
}

export async function listTasks(env: Env, context: AuthContext, url: URL): Promise<unknown> {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size') ?? '20')));
  const offset = (page - 1) * pageSize;
  const requestedProjectId = url.searchParams.get('project_id')?.trim();
  const filter = requestedProjectId
    ? { sql: 't.project_id = ?', bindings: [requestedProjectId] }
    : projectFilter(context, 't');
  if (requestedProjectId) assertProjectRead(context, requestedProjectId);
  const result = await env.DB.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM assets a WHERE a.task_id = t.id) AS asset_count,
      (SELECT COUNT(*) FROM findings f WHERE f.task_id = t.id) AS finding_count
    FROM tasks t
    WHERE ${filter.sql}
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...filter.bindings, pageSize, offset).all();
  return { page, page_size: pageSize, items: result.results };
}

export async function getTaskDetail(env: Env, context: AuthContext, taskId: string): Promise<unknown> {
  const filter = projectFilter(context, 't');
  const task = await env.DB.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM task_shards s WHERE s.task_id = t.id) AS shards_total,
      (SELECT COUNT(*) FROM task_shards s WHERE s.task_id = t.id AND s.status = 'success') AS shards_success,
      (SELECT COUNT(*) FROM assets a WHERE a.task_id = t.id) AS asset_count,
      (SELECT COUNT(*) FROM findings f WHERE f.task_id = t.id) AS finding_count,
      (SELECT COUNT(*) FROM artifacts ar WHERE ar.task_id = t.id) AS artifact_count
    FROM tasks t WHERE t.id = ? AND ${filter.sql}
  `).bind(taskId, ...filter.bindings).first();
  if (!task) throw new HttpError(404, 'task not found');
  return task;
}

export async function listShards(env: Env, context: AuthContext, taskId: string): Promise<unknown> {
  await requireTaskAccess(env, context, taskId);
  const rows = await env.DB.prepare('SELECT * FROM task_shards WHERE task_id = ? ORDER BY created_at ASC').bind(taskId).all();
  return { items: rows.results };
}

export async function listAgentRuns(env: Env, context: AuthContext, taskId: string): Promise<unknown> {
  await requireTaskAccess(env, context, taskId);
  const rows = await env.DB.prepare(`
    SELECT id, task_id, shard_id, provider, provider_job_id, provider_eip_id, provider_egress_ip, status, image, region,
      started_at, finished_at, duration_seconds, exit_code, error_message,
      provider_status, provider_container_state, provider_status_reason, provider_status_message, provider_exit_code,
      provider_events_json, provider_diagnostics_updated_at,
      provider_cleanup_attempts, provider_cleanup_last_error, provider_cleanup_completed_at,
      created_at, updated_at, last_heartbeat_at, timeout_at, retryable
    FROM agent_runs
    WHERE task_id = ?
    ORDER BY created_at ASC
  `).bind(taskId).all();
  return { items: rows.results };
}

export async function cancelTask(env: Env, context: AuthContext, taskId: string): Promise<unknown> {
  const task = await env.DB.prepare('SELECT id, project_id, status FROM tasks WHERE id = ?').bind(taskId).first<{ id: string; project_id: string; status: string }>();
  if (!task) throw new HttpError(404, 'task not found');
  assertProjectWrite(context, task.project_id);
  if (task.status === 'cancelled') return { task_id: taskId, status: 'cancelled', already_cancelled: true, cleanup: [] };
  if (['completed', 'failed', 'timeout'].includes(task.status)) throw new HttpError(409, `cannot cancel terminal task in status ${task.status}`);
  const now = nowIso();
  const message = `cancelled by ${context.actor_id}`;
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE tasks SET status = 'cancelled', dispatch_claim = NULL, error_message = ?, cancelled_at = ?, cancelled_by = ?,
        finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed', 'timeout', 'cancelled')
    `).bind(message, now, context.actor_id, now, now, taskId),
    env.DB.prepare(`
      UPDATE agent_runs SET status = 'cancelled', exit_code = 130, error_message = ?,
        duration_seconds = COALESCE(duration_seconds, CAST(MAX(0, (julianday(?) - julianday(COALESCE(started_at, created_at))) * 86400) AS INTEGER)),
        finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE task_id = ? AND status IN ('starting', 'running')
        AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'cancelled' AND cancelled_at = ? AND cancelled_by = ?)
    `).bind(message, now, now, now, taskId, taskId, now, context.actor_id),
    env.DB.prepare(`
      UPDATE task_shards SET status = 'cancelled', error_message = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE task_id = ? AND status IN ('provisioning', 'running')
        AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'cancelled' AND cancelled_at = ? AND cancelled_by = ?)
    `).bind(message, now, now, taskId, taskId, now, context.actor_id),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) === 0) {
    const current = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(taskId).first<{ status: string }>();
    if (current?.status === 'cancelled') return { task_id: taskId, status: 'cancelled', already_cancelled: true, cleanup: [] };
    throw new HttpError(409, `cannot cancel terminal task in status ${current?.status ?? 'unknown'}`);
  }
  const runs = await env.DB.prepare(`
    SELECT id, task_id, provider, provider_job_id, provider_cleanup_attempts
    FROM agent_runs WHERE task_id = ? AND status = 'cancelled'
  `).bind(taskId).all<CancellableRunRow>();
  const cleanup = [];
  for (const run of runs.results) cleanup.push({ agent_run_id: run.id, ...(await cleanupProviderRunAndSchedule(env, run)) });
  await writeAudit(env, { actor: context.actor_id, action: 'task.cancel', entity_type: 'task', entity_id: taskId, project_id: task.project_id, metadata: { previous_status: task.status, cleanup } });
  return { task_id: taskId, status: 'cancelled', already_cancelled: false, cleanup };
}

export async function requireTaskAccess(env: Env, context: AuthContext, taskId: string): Promise<TaskProjectRow> {
  const task = await env.DB.prepare('SELECT id, project_id FROM tasks WHERE id = ?').bind(taskId).first<TaskProjectRow>();
  if (!task) throw new HttpError(404, 'task not found');
  assertProjectRead(context, task.project_id);
  return task;
}

async function loadProjectScope(env: Env, context: AuthContext, projectId: string): Promise<string[]> {
  assertProjectRead(context, projectId);
  const project = await env.DB.prepare('SELECT id, scope_json FROM projects WHERE id = ?').bind(projectId).first<ProjectRow>();
  if (!project) throw new HttpError(404, 'project not found');
  return parseProjectScope(project.scope_json);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value ?? fallback);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function parseContractValue<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : 'invalid task contract value');
  }
}

function optionalPositiveNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function assertPilotTaskPolicy(env: Env, targets: string[], modules: string[], externalSources: string[], maxAgents: number, rateLimit: number, timeoutMinutes: number): void {
  if (env.ENV !== 'pilot') return;
  if (targets.length !== 1) throw new HttpError(400, 'pilot tasks require exactly one authorized root target');
  const requiredModules = ['subdomain', 'http_probe', 'nuclei'];
  if (modules.length !== requiredModules.length || requiredModules.some((module) => !modules.includes(module))) {
    throw new HttpError(400, 'pilot tasks require the fixed subdomain + http_probe + nuclei toolchain');
  }
  if (externalSources.length) throw new HttpError(400, 'pilot tasks do not allow external sources');
  if (maxAgents !== 1) throw new HttpError(400, 'pilot tasks require max_agents=1');
  if (rateLimit !== 1) throw new HttpError(400, 'pilot tasks require rate_limit=1');
  if (timeoutMinutes > 15) throw new HttpError(400, 'pilot tasks require timeout_minutes <= 15');
}
