import type { AuthContext, ProjectRole } from '../auth';
import type { Env } from '../env';
import { canAccessProject } from '../auth';
import { newId, nowIso } from '../ids';
import { HttpError } from '../response';
import { writeAudit } from './audit-service';

const PROJECT_ROLES = new Set<ProjectRole>(['owner', 'admin', 'operator', 'reader']);

export interface UpdateMembershipInput {
  role?: string;
  status?: string;
}

export interface UpdateProjectSettingsInput {
  artifact_retention_days?: number;
  metadata_retention_days?: number;
  audit_retention_days?: number;
}

export async function listProjectMembers(env: Env, context: AuthContext, projectId: string): Promise<unknown> {
  assertProjectAdmin(context, projectId);
  const result = await env.DB.prepare(`
    SELECT pm.user_id, u.email, u.role AS global_role, u.status AS user_status,
      pm.role, pm.status, pm.created_at, pm.updated_at
    FROM project_memberships pm INNER JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ? ORDER BY u.email ASC
  `).bind(projectId).all();
  return { items: result.results };
}

export async function updateProjectMember(env: Env, context: AuthContext, projectId: string, userId: string, input: UpdateMembershipInput): Promise<unknown> {
  assertProjectAdmin(context, projectId);
  const role = String(input.role ?? '').trim() as ProjectRole;
  const status = input.status === undefined || input.status === 'active' ? 'active' : input.status === 'disabled' ? 'disabled' : null;
  if (!PROJECT_ROLES.has(role)) throw new HttpError(400, 'role must be owner, admin, operator, or reader');
  if (!status) throw new HttpError(400, 'status must be active or disabled');
  if (role === 'owner' && context.project_roles[projectId] !== 'owner') throw new HttpError(403, 'only a project owner can assign owner role');
  const user = await env.DB.prepare('SELECT id, status FROM users WHERE id = ?').bind(userId).first<{ id: string; status: string }>();
  if (!user) throw new HttpError(404, 'user not found');
  if (status === 'active' && user.status !== 'active') throw new HttpError(409, 'cannot activate membership for disabled user');
  const current = await env.DB.prepare(`SELECT id, role, status FROM project_memberships WHERE project_id = ? AND user_id = ?`).bind(projectId, userId).first<{ id: string; role: string; status: string }>();
  if (current?.role === 'owner' && current.status === 'active' && (role !== 'owner' || status !== 'active')) {
    const owners = await env.DB.prepare(`SELECT COUNT(*) AS count FROM project_memberships WHERE project_id = ? AND role = 'owner' AND status = 'active'`).bind(projectId).first<{ count: number }>();
    if (Number(owners?.count ?? 0) <= 1) throw new HttpError(409, 'project must retain at least one active owner');
  }
  const now = nowIso();
  const id = current?.id ?? newId('pm');
  try {
    await env.DB.prepare(`
      INSERT INTO project_memberships (id, project_id, user_id, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, status = excluded.status, updated_at = excluded.updated_at
    `).bind(id, projectId, userId, role, status, now, now).run();
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)).includes('project must retain at least one active owner')) {
      throw new HttpError(409, 'project must retain at least one active owner');
    }
    throw error;
  }
  await writeAudit(env, { actor: context.actor_id, action: 'project.member.update', entity_type: 'project_membership', entity_id: id, project_id: projectId, metadata: { user_id: userId, role, status } });
  return { id, project_id: projectId, user_id: userId, role, status, updated_at: now };
}

export async function updateProjectSettings(env: Env, context: AuthContext, projectId: string, input: UpdateProjectSettingsInput): Promise<unknown> {
  assertProjectAdmin(context, projectId);
  const defaults = retentionDefaults(env);
  const artifact = boundedDays(input.artifact_retention_days, defaults.artifact, 1, defaults.artifact, 'artifact_retention_days');
  const metadata = boundedDays(input.metadata_retention_days, defaults.metadata, 30, defaults.metadata, 'metadata_retention_days');
  const audit = boundedDays(input.audit_retention_days, defaults.audit, 30, defaults.audit, 'audit_retention_days');
  const now = nowIso();
  const result = await env.DB.prepare(`
    UPDATE projects SET artifact_retention_days = ?, metadata_retention_days = ?, audit_retention_days = ?, updated_at = ? WHERE id = ?
  `).bind(artifact, metadata, audit, now, projectId).run();
  if (!result.meta.changes) throw new HttpError(404, 'project not found');
  await writeAudit(env, { actor: context.actor_id, action: 'project.settings.update', entity_type: 'project', entity_id: projectId, project_id: projectId, metadata: { artifact_retention_days: artifact, metadata_retention_days: metadata, audit_retention_days: audit } });
  return { project_id: projectId, artifact_retention_days: artifact, metadata_retention_days: metadata, audit_retention_days: audit, updated_at: now };
}

export function retentionDefaults(env: Env): { artifact: number; metadata: number; audit: number } {
  return {
    artifact: parseDays(env.ARTIFACT_RETENTION_DAYS, 30, 1, 365),
    metadata: parseDays(env.METADATA_RETENTION_DAYS, 180, 30, 3650),
    audit: parseDays(env.AUDIT_RETENTION_DAYS, 180, 30, 3650),
  };
}

function assertProjectAdmin(context: AuthContext, projectId: string): void {
  if (!canAccessProject(context, projectId, 'admin')) throw new HttpError(403, `project admin access denied: ${projectId}`);
}

function boundedDays(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  return num;
}

function parseDays(value: string | undefined, fallback: number, min: number, max: number): number {
  const num = Number(value);
  return Number.isInteger(num) && num >= min && num <= max ? num : fallback;
}
