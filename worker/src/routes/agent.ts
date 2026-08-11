import type { Env } from '../env';
import type { IngestPayload } from '../types/api';
import { requireAgentIdentity } from '../services/agent-token';
import { ingestAgentPayload } from '../services/ingest-service';
import { markCompleted, markFailed, markRunning } from '../services/state-machine';
import { externalCandidatesKey, getObject, targetCandidatesKey } from '../services/r2-service';
import { ok, readJson, HttpError } from '../response';
import { cleanupProviderRun } from '../services/provider-cleanup-service';

interface AgentBasePayload {
  task_id: string;
  shard_id: string;
  agent_run_id: string;
  error_message?: string;
}

export async function handleAgent(request: Request, env: Env, path: string, context?: ExecutionContext, requestId?: string): Promise<Response | null> {
  if (!path.startsWith('/api/agent/')) return null;
  const identity = await requireAgentIdentity(request, env);
  console.log(JSON.stringify({
    event: 'agent.request',
    request_id: requestId ?? null,
    method: request.method,
    path,
    task_id: identity.task_id,
    shard_id: identity.shard_id,
    agent_run_id: identity.agent_run_id,
    provider: identity.provider,
  }));

  if (path === '/api/agent/config' && request.method === 'GET') {
    return downloadAgentObject(env, identity.task_id, 'config');
  }

  if (path === '/api/agent/targets' && request.method === 'GET') {
    return downloadAgentObject(env, identity.task_id, 'targets');
  }

  if (path === '/api/agent/candidates' && request.method === 'GET') {
    return downloadAgentCandidates(env, identity.task_id);
  }

  if (request.method !== 'POST') throw new HttpError(405, 'method not allowed');

  if (path === '/api/agent/heartbeat') {
    const body = await readJson<AgentBasePayload>(request);
    assertMatches(identity, body);
    const transitioned = await markRunning(env, body.task_id, body.shard_id, body.agent_run_id);
    if (!transitioned) throw new HttpError(409, 'agent run became terminal before heartbeat');
    return ok({ status: 'running' });
  }

  if (path === '/api/agent/ingest') {
    const body = await readJson<IngestPayload>(request);
    assertMatches(identity, body);
    return ok(await ingestAgentPayload(env, body));
  }

  if (path === '/api/agent/complete') {
    const body = await readJson<AgentBasePayload>(request);
    assertMatches(identity, body);
    const transitioned = await markCompleted(env, body.task_id, body.shard_id, body.agent_run_id);
    if (!transitioned) throw new HttpError(409, 'agent run became terminal before completion');
    await scheduleTerminalCleanup(env, body.task_id, body.agent_run_id, context);
    return ok({ task_completed: true });
  }

  if (path === '/api/agent/fail') {
    const body = await readJson<AgentBasePayload>(request);
    assertMatches(identity, body);
    const transitioned = await markFailed(env, body.task_id, body.shard_id, body.agent_run_id, body.error_message ?? 'agent failed');
    if (!transitioned) throw new HttpError(409, 'agent run became terminal before failure callback');
    await scheduleTerminalCleanup(env, body.task_id, body.agent_run_id, context);
    return ok({ status: 'failed' });
  }

  throw new HttpError(404, 'agent route not found');
}

async function scheduleTerminalCleanup(env: Env, taskId: string, agentRunId: string, context?: ExecutionContext): Promise<void> {
  const run = await env.DB.prepare(`
    SELECT id, task_id, provider, provider_job_id, provider_cleanup_attempts
    FROM agent_runs WHERE id = ? AND task_id = ?
  `).bind(agentRunId, taskId).first<{ id: string; task_id: string; provider: string; provider_job_id: string | null; provider_cleanup_attempts: number }>();
  if (!run || run.provider !== 'tencent_eks_ci') return;
  const cleanup = cleanupProviderRun(env, run).catch((error) => {
    console.error(JSON.stringify({ event: 'provider.cleanup.schedule_failed', task_id: taskId, agent_run_id: agentRunId, error: error instanceof Error ? error.message : String(error) }));
  });
  if (context) context.waitUntil(cleanup);
  else await cleanup;
}

async function downloadAgentCandidates(env: Env, taskId: string): Promise<Response> {
  const texts = [];
  for (const key of [targetCandidatesKey(taskId), externalCandidatesKey(taskId, 'hunter')]) {
    const object = await getObject(env, key);
    if (object) texts.push(await object.text());
  }
  return new Response(texts.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function downloadAgentObject(env: Env, taskId: string, kind: 'config' | 'targets'): Promise<Response> {
  const task = await env.DB.prepare('SELECT config_r2_key, targets_r2_key FROM tasks WHERE id = ?').bind(taskId).first<{ config_r2_key: string | null; targets_r2_key: string | null }>();
  if (!task) throw new HttpError(404, 'task not found');
  const key = kind === 'config' ? task.config_r2_key : task.targets_r2_key;
  if (!key) throw new HttpError(404, `${kind} object is not available`);
  const object = await getObject(env, key);
  if (!object) throw new HttpError(404, `${kind} object not found in R2`);
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? (kind === 'config' ? 'application/json' : 'text/plain; charset=utf-8'));
  return new Response(object.body, { headers });
}

function assertMatches(identity: AgentBasePayload, payload: AgentBasePayload): void {
  if (identity.task_id !== payload.task_id || identity.shard_id !== payload.shard_id || identity.agent_run_id !== payload.agent_run_id) {
    throw new HttpError(403, 'agent token does not match payload');
  }
}
