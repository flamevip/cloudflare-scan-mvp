import type { Env } from '../env';
import type { AuthContext } from '../auth';
import { assertTokenScope, auditDenied, projectFilter, requireAuthContext } from '../auth';
import { getObject } from '../services/r2-service';
import { ok, HttpError } from '../response';
import { requireTaskAccess } from '../services/task-service';

interface ArtifactRow {
  id: string;
  task_id: string;
  raw_r2_key: string;
  search_r2_key: string | null;
  type: string;
}

export async function handleArtifacts(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
  if (path === '/api/artifacts') {
    const context = await requireAuthContext(request, env);
    assertTokenScope(context, env, 'artifacts:read');
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    const taskId = url.searchParams.get('task_id');
    if (!taskId) throw new HttpError(400, 'task_id is required');
    try {
      await requireTaskAccess(env, context, taskId);
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) await auditDenied(env, context, 'artifact.list', 'task', taskId);
      throw err;
    }
    const rows = await env.DB.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC LIMIT 200').bind(taskId).all();
    return ok({ items: rows.results });
  }

  if (!path.startsWith('/api/artifacts/')) return null;
  const context = await requireAuthContext(request, env);
  assertTokenScope(context, env, 'artifacts:read');
  const match = path.match(/^\/api\/artifacts\/([^/]+)\/(download-url|download)$/);
  if (!match) throw new HttpError(404, 'artifact route not found');
  if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
  const [, artifactId, action] = match;
  const artifact = await getAuthorizedArtifact(env, context, artifactId);
  const kind = url.searchParams.get('type') === 'search' ? 'search' : 'raw';
  const key = kind === 'search' ? artifact.search_r2_key : artifact.raw_r2_key;
  if (!key) throw new HttpError(404, `${kind} artifact is not available`);

  if (action === 'download-url') {
    return ok({ artifact_id: artifactId, type: kind, url: `/api/artifacts/${artifactId}/download?type=${kind}`, expires_in: 300 });
  }

  const object = await getObject(env, key);
  if (!object) throw new HttpError(404, 'artifact object not found in R2');
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${artifactId}-${kind}"`);
  return new Response(object.body, { headers });
}

async function getAuthorizedArtifact(env: Env, context: AuthContext, artifactId: string): Promise<ArtifactRow> {
  const filter = projectFilter(context, 't');
  const artifact = await env.DB.prepare(`
    SELECT ar.*
    FROM artifacts ar INNER JOIN tasks t ON t.id = ar.task_id
    WHERE ar.id = ? AND ${filter.sql}
  `).bind(artifactId, ...filter.bindings).first<ArtifactRow>();
  if (!artifact) {
    await auditDenied(env, context, 'artifact.download', 'artifact', artifactId);
    throw new HttpError(404, 'artifact not found');
  }
  return artifact;
}
