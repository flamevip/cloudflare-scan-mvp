import type { Env } from '../env';
import { nowIso } from '../ids';

const TASK_TERMINAL = "('completed', 'failed', 'timeout', 'cancelled')";
const SHARD_TERMINAL = "('success', 'failed', 'timeout', 'cancelled')";

export async function markRunning(env: Env, taskId: string, shardId: string, agentRunId: string): Promise<boolean> {
  const now = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE agent_runs SET status = 'running', started_at = COALESCE(started_at, ?), last_heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND task_id = ? AND status IN ('starting', 'running')
        AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status NOT IN ${TASK_TERMINAL})
    `).bind(now, now, now, agentRunId, taskId, taskId),
    env.DB.prepare(`
      UPDATE task_shards SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND task_id = ? AND status NOT IN ${SHARD_TERMINAL}
        AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND task_id = ? AND status = 'running' AND updated_at = ?)
    `).bind(now, now, shardId, taskId, agentRunId, taskId, now),
    env.DB.prepare(`
      UPDATE tasks SET status = 'running', dispatch_claim = NULL, started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status NOT IN ${TASK_TERMINAL}
        AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND task_id = ? AND status = 'running' AND updated_at = ?)
    `).bind(now, now, taskId, agentRunId, taskId, now),
  ]);
  return changed(results[0]);
}

export async function markCompleted(env: Env, taskId: string, shardId: string, agentRunId: string): Promise<boolean> {
  const now = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE agent_runs SET status = 'success', exit_code = 0, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND task_id = ? AND status IN ('starting', 'running')
        AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status NOT IN ${TASK_TERMINAL})
    `).bind(now, now, agentRunId, taskId, taskId),
    env.DB.prepare(`
      UPDATE task_shards SET status = 'success', finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND task_id = ? AND status NOT IN ${SHARD_TERMINAL}
        AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND task_id = ? AND status = 'success' AND updated_at = ?)
    `).bind(now, now, shardId, taskId, agentRunId, taskId, now),
    env.DB.prepare(`
      UPDATE tasks SET status = 'completed', dispatch_claim = NULL, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND status NOT IN ${TASK_TERMINAL}
        AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND task_id = ? AND status = 'success' AND updated_at = ?)
        AND NOT EXISTS (SELECT 1 FROM task_shards WHERE task_id = ? AND status != 'success')
    `).bind(now, now, taskId, agentRunId, taskId, now, taskId),
  ]);
  return changed(results[0]);
}

export async function markFailed(env: Env, taskId: string, shardId: string, agentRunId: string, message: string): Promise<boolean> {
  const now = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE agent_runs SET status = 'failed', error_message = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND task_id = ? AND status IN ('starting', 'running')
        AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status NOT IN ${TASK_TERMINAL})
    `).bind(message, now, now, agentRunId, taskId, taskId),
    env.DB.prepare(`
      UPDATE task_shards SET status = 'failed', error_message = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND task_id = ? AND status NOT IN ${SHARD_TERMINAL}
        AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND task_id = ? AND status = 'failed' AND updated_at = ?)
    `).bind(message, now, now, shardId, taskId, agentRunId, taskId, now),
    env.DB.prepare(`
      UPDATE tasks SET status = 'failed', dispatch_claim = NULL, error_message = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND status NOT IN ${TASK_TERMINAL}
        AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND task_id = ? AND status = 'failed' AND updated_at = ?)
    `).bind(message, now, now, taskId, agentRunId, taskId, now),
  ]);
  return changed(results[0]);
}

export async function markRetrying(env: Env, taskId: string, shardId: string, agentRunId: string, message: string, nextAttempt: number): Promise<boolean> {
  const now = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE agent_runs SET status = 'failed', retryable = 1, error_message = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND task_id = ? AND status IN ('starting', 'running')
        AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status NOT IN ${TASK_TERMINAL})
    `).bind(message, now, now, agentRunId, taskId, taskId),
    env.DB.prepare(`
      UPDATE task_shards SET status = 'failed', error_message = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND task_id = ? AND status NOT IN ${SHARD_TERMINAL}
        AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND task_id = ? AND status = 'failed' AND retryable = 1 AND updated_at = ?)
    `).bind(message, now, now, shardId, taskId, agentRunId, taskId, now),
    env.DB.prepare(`
      UPDATE tasks SET status = 'retrying', dispatch_claim = NULL, error_message = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ${TASK_TERMINAL}
        AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND task_id = ? AND status = 'failed' AND retryable = 1 AND updated_at = ?)
    `).bind(`${message}; retry attempt ${nextAttempt}`, now, taskId, agentRunId, taskId, now),
  ]);
  return changed(results[0]);
}

export async function markTimedOut(env: Env, taskId: string, shardId: string, agentRunId: string, message: string, deadletterReason: string): Promise<boolean> {
  const now = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE agent_runs SET status = 'timeout', timeout_at = ?, error_message = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND task_id = ? AND status IN ('starting', 'running')
        AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status NOT IN ${TASK_TERMINAL})
    `).bind(now, message, now, now, agentRunId, taskId, taskId),
    env.DB.prepare(`
      UPDATE task_shards SET status = 'timeout', error_message = ?, deadletter_reason = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND task_id = ? AND status NOT IN ${SHARD_TERMINAL}
        AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND task_id = ? AND status = 'timeout' AND timeout_at = ?)
    `).bind(message, deadletterReason, now, now, shardId, taskId, agentRunId, taskId, now),
    env.DB.prepare(`
      UPDATE tasks SET status = 'timeout', dispatch_claim = NULL, error_message = ?, deadletter_reason = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND status NOT IN ${TASK_TERMINAL}
        AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND task_id = ? AND status = 'timeout' AND timeout_at = ?)
    `).bind(message, deadletterReason, now, now, taskId, agentRunId, taskId, now),
  ]);
  return changed(results[0]);
}

function changed(result: D1Result | undefined): boolean {
  return Number(result?.meta?.changes ?? 0) > 0;
}
