import type { Env } from '../env';
import { assertTokenScope, auditDenied, requireAuthContext } from '../auth';
import { ok, HttpError } from '../response';
import { requireTaskAccess } from '../services/task-service';

export async function handleAssets(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
  if (path !== '/api/assets') return null;
  const context = await requireAuthContext(request, env);
  assertTokenScope(context, env, 'tasks:read');
  if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
  const taskId = url.searchParams.get('task_id');
  if (!taskId) throw new HttpError(400, 'task_id is required');
  try {
    await requireTaskAccess(env, context, taskId);
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) await auditDenied(env, context, 'asset.list', 'task', taskId);
    throw err;
  }
  const rows = await env.DB.prepare('SELECT * FROM assets WHERE task_id = ? ORDER BY created_at DESC LIMIT 200').bind(taskId).all();
  return ok({ items: rows.results });
}
