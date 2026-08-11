import type { Env } from '../env';
import type { CreateTaskRequest } from '../types/api';
import { assertTokenScope, auditDenied, requireAuthContext } from '../auth';
import { ok, readJson, HttpError } from '../response';
import { cancelTask, createTask, getTaskDetail, listAgentRuns, listShards, listTasks } from '../services/task-service';

export async function handleTasks(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
  if (!path.startsWith('/api/tasks')) return null;
  const context = await requireAuthContext(request, env);

  try {
    if (path === '/api/tasks' && request.method === 'POST') {
      assertTokenScope(context, env, 'tasks:write');
      const body = await readJson<CreateTaskRequest>(request);
      return ok(await createTask(env, context, body));
    }
    if (path === '/api/tasks' && request.method === 'GET') {
      assertTokenScope(context, env, 'tasks:read');
      return ok(await listTasks(env, context, url));
    }

    const cancelMatch = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (cancelMatch) {
      if (request.method !== 'POST') throw new HttpError(405, 'method not allowed');
      assertTokenScope(context, env, 'tasks:write');
      return ok(await cancelTask(env, context, cancelMatch[1]));
    }

    const match = path.match(/^\/api\/tasks\/([^/]+)(?:\/(shards|agent-runs))?$/);
    if (!match || request.method !== 'GET') throw new HttpError(404, 'task route not found');
    const [, taskId, sub] = match;
    assertTokenScope(context, env, 'tasks:read');
    if (sub === 'shards') return ok(await listShards(env, context, taskId));
    if (sub === 'agent-runs') return ok(await listAgentRuns(env, context, taskId));
    return ok(await getTaskDetail(env, context, taskId));
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) {
      await auditDenied(env, context, `${request.method} ${path}`, 'task', path.split('/')[3] ?? 'collection', { project_id: url.searchParams.get('project_id') ?? undefined });
    }
    throw err;
  }
}
