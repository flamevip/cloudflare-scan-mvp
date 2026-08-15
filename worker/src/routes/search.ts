import type { Env } from '../env';
import { assertTokenScope, auditDenied, requireAdminContext, requireAuthContext } from '../auth';
import { ok, HttpError } from '../response';
import { getSearchStatus, searchArtifacts } from '../services/search-service';

export async function handleSearch(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
  if (path === '/api/admin/search/status') {
    await requireAdminContext(request, env);
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    return ok(await getSearchStatus(env, url));
  }

  if (path !== '/api/search') return null;
  const context = await requireAuthContext(request, env);
  assertTokenScope(context, env, 'search:read');
  if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
  try {
    return ok(await searchArtifacts(env, context, url));
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      const taskId = url.searchParams.get('task_id') ?? 'collection';
      await auditDenied(env, context, 'search.query', 'task', taskId);
    }
    throw error;
  }
}
