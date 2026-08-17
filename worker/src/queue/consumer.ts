import type { Env } from '../env';
import type { ScanDispatchMessage, TaskCreatedMessage } from '../types/queue';
import { newId, nowIso } from '../ids';
import { agentTokenTtlSeconds, createAgentToken } from '../services/agent-token';
import { deleteAgentProviderJob, initialProviderRunMetadata, isExternalAgentProvider, launchAgentProvider, resolveProviderLaunchPlan } from '../services/agent-provider';
import { runHunterEnrichment } from '../services/hunter-service';
import { decideRetry, parseMaxRetry } from '../services/retry-policy';
import { runInlineMockAgent } from '../services/mock-agent-service';
import { markFailed, markRetrying } from '../services/state-machine';
import { toProviderLaunchError, serializeProviderError, type ProviderLaunchError } from '../services/provider-errors';
import { cleanupProviderRunAndSchedule, processProviderCleanupMessage } from '../services/provider-cleanup-service';
import { isTencentEksCiDryRun } from '../services/tencent-eks-ci-service';
import { writeAudit } from '../services/audit-service';

interface TaskRow {
  id: string;
  project_id: string;
  status: string;
  targets_json: string;
  modules_json: string;
  external_sources_json: string;
  target_count: number;
  rate_limit: number;
  timeout_minutes: number;
  max_cost_usd?: number | null;
  config_r2_key: string;
  targets_r2_key: string;
}

export async function processDispatchMessage(env: Env, message: ScanDispatchMessage): Promise<void> {
  if (message.type === 'deployment.canary') {
    await writeAudit(env, {
      actor: 'system',
      action: 'queue.consumer.canary',
      entity_type: 'deployment_canary',
      entity_id: message.nonce,
      metadata: {
        environment: env.ENV,
        tencent_dry_run_enabled: isTencentEksCiDryRun(env.TENCENT_EKS_CI_DRY_RUN),
      },
    });
    return;
  }
  if (message.type === 'provider.cleanup') {
    await processProviderCleanupMessage(env, message);
    return;
  }
  assertRequiredProviderMode(env, message);
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(message.task_id).first<TaskRow>();
  if (!task) {
    await env.SCAN_DEADLETTER?.send(message);
    return;
  }
  if (!['pending', 'provisioning', 'retrying'].includes(task.status)) return;

  const active = await env.DB.prepare(`
    SELECT id, agent_run_id FROM task_shards
    WHERE task_id = ? AND status IN ('provisioning', 'running')
    LIMIT 1
  `).bind(task.id).first<{ id: string; agent_run_id: string }>();
  if (active) return;

  const now = nowIso();
  const shardId = newId('shard');
  const agentRunId = newId('run');
  const token = await createAgentToken(env, { task_id: task.id, shard_id: shardId, agent_run_id: agentRunId }, agentTokenTtlSeconds(task.timeout_minutes));
  const launchPlan = resolveProviderLaunchPlan(env, task);
  const provider = launchPlan.provider;
  const initialMetadata = initialProviderRunMetadata(env, provider);
  const maxRetry = parseMaxRetry(env.TASK_MAX_RETRY);
  const attempt = Math.max(1, Math.floor(message.attempt || 1));

  const claim = await env.DB.batch([
    env.DB.prepare(`
      UPDATE tasks SET status = 'provisioning', dispatch_claim = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'provisioning', 'retrying')
        AND NOT EXISTS (
          SELECT 1 FROM task_shards
          WHERE task_id = ? AND status IN ('provisioning', 'running')
        )
    `).bind(shardId, now, task.id, task.id),
    env.DB.prepare(`
      INSERT INTO task_shards (id, task_id, module, status, targets_r2_key, config_r2_key, target_count, retry_count, max_retry, agent_run_id, created_at, updated_at)
      SELECT ?, ?, 'scan_pipeline', 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'provisioning' AND dispatch_claim = ?)
    `).bind(shardId, task.id, task.targets_r2_key, task.config_r2_key, task.target_count, attempt - 1, maxRetry, agentRunId, now, now, task.id, shardId),
    env.DB.prepare(`
      INSERT INTO agent_runs (id, task_id, shard_id, provider, provider_job_id, status, image, region, callback_token, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM task_shards WHERE id = ? AND task_id = ? AND agent_run_id = ?)
    `).bind(agentRunId, task.id, shardId, initialMetadata.provider, initialMetadata.provider_job_id, initialMetadata.image, initialMetadata.region, token, now, now, shardId, task.id, agentRunId),
  ]);
  if (!changed(claim[0]) || !changed(claim[2])) return;

  const targets = JSON.parse(task.targets_json) as string[];
  const externalSources = JSON.parse(task.external_sources_json || '[]') as string[];
  const hunterResult = await runHunterEnrichment(env, { task_id: task.id, shard_id: shardId, targets, external_sources: externalSources });
  if (hunterResult.status === 'failed') {
    await recordProviderNote(env, task.id, agentRunId, `hunter failed retryable=${hunterResult.retryable}: ${hunterResult.message}`);
  }

  if (provider === 'mock_inline') {
    await runInlineMockAgent(env, task.id, shardId, agentRunId, targets[0] ?? 'example.com');
    return;
  }

  if (isExternalAgentProvider(provider)) {
    if (launchPlan.candidates.length === 0) {
      const reason = launchPlan.auto_decision?.reason ?? 'no provider candidates available';
      await handleLaunchFailure(env, message, task, shardId, agentRunId, reason, false, maxRetry);
      return;
    }

    const failures: ProviderLaunchError[] = [];
    for (const candidate of launchPlan.candidates) {
      try {
        const activeAttempt = await updateProviderAttempt(env, task.id, agentRunId, candidate, failures.map((failure) => failure.safe_message));
        if (!activeAttempt) return;
        const result = await launchAgentProvider(env, candidate, { task, shard_id: shardId, agent_run_id: agentRunId, callback_token: token });
        const persisted = await updateProviderLaunch(env, task.id, agentRunId, candidate, result.provider_job_id, result.image, result.region, result.provider_eip_id ?? null, result.provider_egress_ip ?? null, failures.map((failure) => failure.safe_message));
        if (!persisted) {
          await recordLateProviderLaunchAndCleanup(env, task.id, agentRunId, candidate, result.provider_job_id, result.image, result.region);
        }
        return;
      } catch (err) {
        failures.push(toProviderLaunchError(err, candidate));
      }
    }
    const summary = summarizeLaunchFailures(failures, `${provider} launch failed`);
    await handleLaunchFailure(env, message, task, shardId, agentRunId, summary.reason, summary.retryable, maxRetry);
  }
}

export function summarizeLaunchFailures(failures: ProviderLaunchError[], fallbackReason: string): { reason: string; retryable: boolean; errors: Record<string, unknown>[] } {
  if (!failures.length) return { reason: fallbackReason, retryable: false, errors: [] };
  return {
    reason: failures.map((failure) => failure.safe_message).join('; '),
    retryable: failures.some((failure) => failure.retryable),
    errors: failures.map(serializeProviderError),
  };
}

async function handleLaunchFailure(env: Env, message: TaskCreatedMessage, task: TaskRow, shardId: string, agentRunId: string, reason: string, retryable: boolean, maxRetry: number): Promise<void> {
  const decision = decideRetry({ attempt: message.attempt, maxRetry, retryable });
  if (decision.action === 'retry' && decision.next_attempt) {
    const transitioned = await markRetrying(env, task.id, shardId, agentRunId, reason, decision.next_attempt);
    if (transitioned === false) return;
    const retryMessage: ScanDispatchMessage = { ...message, attempt: decision.next_attempt, created_at: nowIso() };
    await env.SCAN_DISPATCH.send(retryMessage);
    await auditQueueDecision(env, task.id, task.project_id, 'queue.retry', reason, message.attempt, maxRetry, decision.reason);
    return;
  }
  const transitioned = await markFailed(env, task.id, shardId, agentRunId, reason);
  if (transitioned === false) return;
  await env.SCAN_DEADLETTER?.send({ ...message, attempt: message.attempt || 1, created_at: nowIso() });
  await auditQueueDecision(env, task.id, task.project_id, 'queue.deadletter', reason, message.attempt, maxRetry, decision.reason);
}

export class QueueProviderModeMismatchError extends Error {}

function assertRequiredProviderMode(env: Env, message: TaskCreatedMessage): void {
  if (!message.required_provider_mode) return;
  const actual = isTencentEksCiDryRun(env.TENCENT_EKS_CI_DRY_RUN) ? 'dry_run' : 'live';
  if (message.required_provider_mode !== actual) {
    throw new QueueProviderModeMismatchError(`queue consumer provider mode is ${actual}; message requires ${message.required_provider_mode}`);
  }
}

async function recordProviderNote(env: Env, taskId: string, agentRunId: string, note: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE agent_runs SET error_message = ?, updated_at = ? WHERE id = ? AND task_id = ?
  `).bind(note, nowIso(), agentRunId, taskId).run();
}

async function updateProviderAttempt(env: Env, taskId: string, agentRunId: string, provider: string, failures: string[]): Promise<boolean> {
  const note = failures.length ? `fallback after ${failures.join('; ')}` : null;
  const result = await env.DB.prepare(`
    UPDATE agent_runs SET provider = ?, error_message = ?, updated_at = ?
    WHERE id = ? AND task_id = ? AND status IN ('starting', 'running')
      AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status NOT IN ('completed', 'failed', 'timeout', 'cancelled'))
  `).bind(provider, note, nowIso(), agentRunId, taskId, taskId).run();
  return changed(result);
}

async function updateProviderLaunch(env: Env, taskId: string, agentRunId: string, provider: string, providerJobId: string, image: string, region: string, providerEipId: string | null, providerEgressIp: string | null, failures: string[]): Promise<boolean> {
  const note = failures.length ? `fallback after ${failures.join('; ')}` : null;
  const result = await env.DB.prepare(`
    UPDATE agent_runs SET provider = ?, provider_job_id = ?, image = ?, region = ?,
      provider_eip_id = COALESCE(?, provider_eip_id), provider_egress_ip = COALESCE(?, provider_egress_ip),
      error_message = ?, updated_at = ?
    WHERE id = ? AND task_id = ? AND status IN ('starting', 'running')
      AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status NOT IN ('completed', 'failed', 'timeout', 'cancelled'))
  `).bind(provider, providerJobId, image, region, providerEipId, providerEgressIp, note, nowIso(), agentRunId, taskId, taskId).run();
  return changed(result);
}

async function recordLateProviderLaunchAndCleanup(env: Env, taskId: string, agentRunId: string, provider: string, providerJobId: string, image: string, region: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE agent_runs
    SET provider = ?, provider_job_id = ?, image = ?, region = ?,
      provider_cleanup_attempts = 0, provider_cleanup_last_error = NULL,
      provider_cleanup_completed_at = NULL, updated_at = ?
    WHERE id = ? AND task_id = ?
  `).bind(provider, providerJobId, image, region, nowIso(), agentRunId, taskId).run();
  const run = await env.DB.prepare(`
    SELECT id, task_id, provider, provider_job_id, provider_cleanup_attempts
    FROM agent_runs WHERE id = ? AND task_id = ?
  `).bind(agentRunId, taskId).first<{ id: string; task_id: string; provider: string; provider_job_id: string | null; provider_cleanup_attempts: number }>();
  const cleanup = run
    ? await cleanupProviderRunAndSchedule(env, run)
    : { ...(await deleteAgentProviderJob(env, provider as Parameters<typeof deleteAgentProviderJob>[1], providerJobId)), completed: true };
  console.log(JSON.stringify({
    event: 'provider.launch.late_cleanup',
    task_id: taskId,
    agent_run_id: agentRunId,
    provider,
    provider_job_id: providerJobId,
    cleanup_completed: cleanup.completed,
  }));
}

async function auditQueueDecision(env: Env, taskId: string, projectId: string, action: string, reason: string, attempt: number, maxRetry: number, decision: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, project_id, metadata_json, created_at)
    VALUES (?, 'system', ?, 'task', ?, ?, ?, ?)
  `).bind(newId('audit'), action, taskId, projectId, JSON.stringify({ reason, attempt, max_retry: maxRetry, decision }), nowIso()).run();
}

function changed(result: D1Result | undefined): boolean {
  return Number(result?.meta?.changes ?? 0) > 0;
}
