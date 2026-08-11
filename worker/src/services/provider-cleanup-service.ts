import type { Env } from '../env';
import { newId, nowIso } from '../ids';
import { deleteAgentProviderJob, type ExternalAgentProvider } from './agent-provider';
import { serializeProviderError, toProviderLaunchError } from './provider-errors';

const MAX_CLEANUP_ATTEMPTS = 5;
const CLEANUP_BATCH_SIZE = 20;

interface CleanupRunRow {
  id: string;
  task_id: string;
  provider: string;
  provider_job_id: string | null;
  provider_cleanup_attempts: number;
}

export interface ProviderCleanupResult {
  attempted: boolean;
  completed: boolean;
  already_absent: boolean;
  error: string | null;
}

export interface ProviderCleanupSweepResult {
  checked: number;
  completed: number;
  failed: number;
}

export async function cleanupProviderRun(env: Env, run: CleanupRunRow): Promise<ProviderCleanupResult> {
  if (run.provider !== 'tencent_eks_ci') return { attempted: false, completed: true, already_absent: true, error: null };
  if (!run.provider_job_id || run.provider_job_id.startsWith('dry-run:')) {
    await markCleanupCompleted(env, run.id, run.task_id);
    return { attempted: false, completed: true, already_absent: true, error: null };
  }
  try {
    const result = await deleteAgentProviderJob(env, run.provider as ExternalAgentProvider, run.provider_job_id);
    await markCleanupCompleted(env, run.id, run.task_id);
    await auditCleanup(env, run.task_id, 'provider.cleanup.completed', {
      agent_run_id: run.id,
      provider: run.provider,
      already_absent: result.already_absent,
    });
    console.log(JSON.stringify({ event: 'provider.cleanup.completed', task_id: run.task_id, agent_run_id: run.id, provider: run.provider, provider_job_id: run.provider_job_id, already_absent: result.already_absent }));
    return { attempted: true, completed: true, already_absent: result.already_absent, error: null };
  } catch (error) {
    const providerError = toProviderLaunchError(error, 'tencent_eks_ci');
    const attempts = Math.max(0, run.provider_cleanup_attempts) + 1;
    await env.DB.prepare(`
      UPDATE agent_runs
      SET provider_cleanup_attempts = ?, provider_cleanup_last_error = ?, updated_at = ?
      WHERE id = ? AND task_id = ? AND provider_cleanup_completed_at IS NULL
    `).bind(attempts, providerError.safe_message, nowIso(), run.id, run.task_id).run();
    await auditCleanup(env, run.task_id, 'provider.cleanup.failed', {
      agent_run_id: run.id,
      provider: run.provider,
      attempt: attempts,
      max_attempts: MAX_CLEANUP_ATTEMPTS,
      error: serializeProviderError(providerError),
    });
    console.error(JSON.stringify({ event: 'provider.cleanup.failed', task_id: run.task_id, agent_run_id: run.id, provider: run.provider, provider_job_id: run.provider_job_id, attempt: attempts, max_attempts: MAX_CLEANUP_ATTEMPTS, error: providerError.safe_message }));
    return { attempted: true, completed: false, already_absent: false, error: providerError.safe_message };
  }
}

export async function sweepProviderCleanup(env: Env): Promise<ProviderCleanupSweepResult> {
  const rows = await env.DB.prepare(`
    SELECT id, task_id, provider, provider_job_id, provider_cleanup_attempts
    FROM agent_runs
    WHERE provider = 'tencent_eks_ci'
      AND status IN ('success', 'failed', 'timeout', 'cancelled')
      AND provider_cleanup_completed_at IS NULL
      AND provider_cleanup_attempts < ?
    ORDER BY finished_at ASC, created_at ASC
    LIMIT ?
  `).bind(MAX_CLEANUP_ATTEMPTS, CLEANUP_BATCH_SIZE).all<CleanupRunRow>();
  const result: ProviderCleanupSweepResult = { checked: rows.results.length, completed: 0, failed: 0 };
  for (const row of rows.results) {
    const cleanup = await cleanupProviderRun(env, row);
    if (cleanup.completed) result.completed += 1;
    else result.failed += 1;
  }
  return result;
}

async function markCleanupCompleted(env: Env, agentRunId: string, taskId: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(`
    UPDATE agent_runs
    SET provider_cleanup_completed_at = COALESCE(provider_cleanup_completed_at, ?),
        provider_cleanup_last_error = NULL,
        updated_at = ?
    WHERE id = ? AND task_id = ?
  `).bind(now, now, agentRunId, taskId).run();
}

async function auditCleanup(env: Env, taskId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, project_id, metadata_json, created_at)
    VALUES (?, 'system', ?, 'task', ?, (SELECT project_id FROM tasks WHERE id = ?), ?, ?)
  `).bind(newId('audit'), action, taskId, taskId, JSON.stringify(metadata), nowIso()).run();
}
