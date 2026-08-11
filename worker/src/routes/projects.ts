import type { Env } from '../env';
import { assertTokenScope, auditDenied, requireAuthContext, sanitizedAuthContext } from '../auth';
import { ok, HttpError, readJson } from '../response';
import { listProjectMembers, updateProjectMember, updateProjectSettings, type UpdateMembershipInput, type UpdateProjectSettingsInput } from '../services/project-admin-service';

export async function handleProjects(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/api/auth/me') {
    const context = await requireAuthContext(request, env);
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    return ok(sanitizedAuthContext(context));
  }

  if (!path.startsWith('/api/projects')) return null;
  const context = await requireAuthContext(request, env);

  if (path === '/api/projects') {
    assertTokenScope(context, env, 'tasks:read');
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    const ids = context.project_ids.length ? context.project_ids : ['__none__'];
    const rows = await env.DB.prepare(`
      SELECT p.id, p.name, p.scope_json, p.artifact_retention_days, p.metadata_retention_days, p.audit_retention_days,
        p.created_at, p.updated_at, pm.role AS membership_role
      FROM projects p INNER JOIN project_memberships pm ON pm.project_id = p.id
      WHERE pm.user_id = ? AND pm.status = 'active' AND p.id IN (${ids.map(() => '?').join(', ')})
      ORDER BY p.name ASC
    `).bind(context.actor_id, ...ids).all();
    return ok({ items: rows.results });
  }

  const members = path.match(/^\/api\/projects\/([^/]+)\/members$/);
  const member = path.match(/^\/api\/projects\/([^/]+)\/members\/([^/]+)$/);
  const settings = path.match(/^\/api\/projects\/([^/]+)\/settings$/);
  try {
    assertTokenScope(context, env, 'admin:*');
    if (members) {
      if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
      return ok(await listProjectMembers(env, context, members[1]));
    }
    if (member) {
      if (request.method !== 'PUT') throw new HttpError(405, 'method not allowed');
      return ok(await updateProjectMember(env, context, member[1], member[2], await readJson<UpdateMembershipInput>(request)));
    }
    if (settings) {
      if (request.method !== 'PUT') throw new HttpError(405, 'method not allowed');
      return ok(await updateProjectSettings(env, context, settings[1], await readJson<UpdateProjectSettingsInput>(request)));
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      const projectId = members?.[1] ?? member?.[1] ?? settings?.[1] ?? 'collection';
      await auditDenied(env, context, `${request.method} ${path}`, 'project', projectId);
    }
    throw error;
  }
  throw new HttpError(404, 'project route not found');
}
