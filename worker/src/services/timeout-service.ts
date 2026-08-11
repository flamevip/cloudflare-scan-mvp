import type { Env } from '../env';
import type { ScanDispatchMessage } from '../types/queue';
import { newId, nowIso } from '../ids';
import { decideRetry, decideTimeout, parseHeartbeatTimeoutSeconds } from './retry-policy';
import { markRetrying, markTimedOut } from './state-machine';
import { cleanupProviderRun } from './provider-cleanup-service';

interface StaleRunRow {
  agent_run_id: string;
  shard_id: string;
  task_id: string;
  project_id: string;
  status: string;
  last_heartbeat_at: string | null;
  started_at: string | null;
  created_at: string;
  retry_count: number;
  max_retry: number;
  config_r2_key: string;
  targets_r2_key: string;
  provider: string;
  provider_job_id: string | null;
  provider_cleanup_attempts: number;
  task_created_at: string;
  task_started_at: string | null;
  timeout_minutes: number;
}

export interface SweepTimeoutsResult {
  checked: number;
  timed_out: number;
  requeued: number;
  deadlettered: number;
}

export async function sweepTimedOutAgentRuns(env: Env): Promise<SweepTimeoutsResult> {
  const timeoutSeconds = parseHeartbeatTimeoutSeconds(env.AGENT_HEARTBEAT_TIMEOUT_SECONDS);
  const now = nowIso();
  const rows = await env.DB.prepare(`
    SELECT ar.id AS agent_run_id, ar.shard_id, ar.task_id, ar.status, ar.last_heartbeat_at, ar.started_at, ar.created_at,
           ar.provider, ar.provider_job_id, ar.provider_cleanup_attempts,
           s.retry_count, s.max_retry, t.project_id, t.config_r2_key, t.targets_r2_key,
           t.created_at AS task_created_at, t.started_at AS task_started_at, t.timeout_minutes
    FROM agent_runs ar
      INNER JOIN task_shards s ON s.id = ar.shard_id
      INNER JOIN tasks t ON t.id = ar.task_id
    WHERE ar.status IN ('starting', 'running')
    ORDER BY ar.created_at ASC
    LIMIT 50
  `).all<StaleRunRow>();

  const result: SweepTimeoutsResult = { checked: rows.results.length, timed_out: 0, requeued: 0, deadlettered: 0 };
  for (const row of rows.results) {
    const heartbeatTimeout = decideTimeout({
      status: row.status,
      lastHeartbeatAt: row.last_heartbeat_at,
      startedAt: row.started_at,
      createdAt: row.created_at,
      now,
      timeoutSeconds,
    });
    const totalDeadlineExceeded = isTaskDeadlineExceeded(row.task_started_at ?? row.task_created_at, row.timeout_minutes, now);
    if (!heartbeatTimeout.timed_out && !totalDeadlineExceeded) continue;
    const attempt = row.retry_count + 1;
    const retry = decideRetry({ attempt, maxRetry: row.max_retry, retryable: !totalDeadlineExceeded });
    const message = totalDeadlineExceeded
      ? `task execution deadline exceeded after ${row.timeout_minutes} minute(s)`
      : `agent heartbeat timeout: ${heartbeatTimeout.reason}`;
    if (retry.action === 'retry' && retry.next_attempt) {
      const transitioned = await markRetrying(env, row.task_id, row.shard_id, row.agent_run_id, message, retry.next_attempt);
      if (!transitioned) continue;
      result.timed_out += 1;
      await cleanupCurrentRun(env, row.agent_run_id, row.task_id);
      const retryMessage: ScanDispatchMessage = {
        type: 'task.created',
        task_id: row.task_id,
        project_id: row.project_id,
        config_r2_key: row.config_r2_key,
        targets_r2_key: row.targets_r2_key,
        attempt: retry.next_attempt,
        created_at: nowIso(),
      };
      await env.SCAN_DISPATCH.send(retryMessage);
      await auditTimeout(env, row.task_id, row.project_id, 'timeout.retry', { attempt, max_retry: row.max_retry, next_attempt: retry.next_attempt, message });
      result.requeued += 1;
    } else {
      const transitioned = await markTimedOut(env, row.task_id, row.shard_id, row.agent_run_id, message, retry.reason);
      if (!transitioned) continue;
      result.timed_out += 1;
      await cleanupCurrentRun(env, row.agent_run_id, row.task_id);
      await env.SCAN_DEADLETTER?.send({
        type: 'task.created',
        task_id: row.task_id,
        project_id: row.project_id,
        config_r2_key: row.config_r2_key,
        targets_r2_key: row.targets_r2_key,
        attempt,
        created_at: nowIso(),
      });
      await auditTimeout(env, row.task_id, row.project_id, 'timeout.deadletter', { attempt, max_retry: row.max_retry, decision: retry.reason, message });
      result.deadlettered += 1;
    }
  }
  return result;
}

async function cleanupCurrentRun(env: Env, agentRunId: string, taskId: string): Promise<void> {
  const run = await env.DB.prepare(`
    SELECT id, task_id, provider, provider_job_id, provider_cleanup_attempts
    FROM agent_runs WHERE id = ? AND task_id = ?
  `).bind(agentRunId, taskId).first<{
    id: string;
    task_id: string;
    provider: string;
    provider_job_id: string | null;
    provider_cleanup_attempts: number;
  }>();
  if (run) await cleanupProviderRun(env, run);
}

function isTaskDeadlineExceeded(startedAt: string, timeoutMinutes: number, now: string): boolean {
  const started = Date.parse(startedAt);
  const observed = Date.parse(now);
  const minutes = Number(timeoutMinutes);
  if (!Number.isFinite(started) || !Number.isFinite(observed) || !Number.isFinite(minutes) || minutes <= 0) return false;
  return observed >= started + minutes * 60_000;
}

async function auditTimeout(env: Env, taskId: string, projectId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, project_id, metadata_json, created_at)
    VALUES (?, 'system', ?, 'task', ?, ?, ?, ?)
  `).bind(newId('audit'), action, taskId, projectId, JSON.stringify(metadata), nowIso()).run();
}
