import type { Env } from './env';
import { newId, nowIso } from './ids';
import { HttpError } from './response';

export type AuthRole = 'admin' | 'reader';
export type ProjectRole = 'owner' | 'admin' | 'operator' | 'reader';
export type TokenType = 'dev_admin' | 'api_token';
export type TokenScope = 'tasks:read' | 'tasks:write' | 'artifacts:read' | 'search:read' | 'admin:*';

export interface ProjectMembership {
  project_id: string;
  role: ProjectRole;
}

export interface AuthContext {
  actor_id: string;
  actor_email?: string;
  role: AuthRole;
  project_ids: string[];
  project_roles: Record<string, ProjectRole>;
  memberships: ProjectMembership[];
  token_type: TokenType;
  token_id?: string;
  token_scopes: string[];
  token_expires_at?: string | null;
}

export interface ProjectFilter {
  sql: string;
  bindings: string[];
}

interface TokenRow {
  token_id: string;
  user_id: string;
  token_hash: string;
  scopes_json: string;
  expires_at: string | null;
  revoked_at: string | null;
  user_role: string;
  user_status: string;
  email: string;
}

interface MembershipRow {
  project_id: string;
  role: string;
}

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  reader: 1,
  operator: 2,
  admin: 3,
  owner: 4,
};

export async function requireAuthContext(request: Request, env: Env): Promise<AuthContext> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, 'missing or invalid bearer token');

  if (env.DEV_ADMIN_TOKEN && token === env.DEV_ADMIN_TOKEN) {
    return devAdminContext(env);
  }

  return requireApiTokenContext(token, env);
}

export async function requireAdminContext(request: Request, env: Env): Promise<AuthContext> {
  const context = await requireAuthContext(request, env);
  assertGlobalAdmin(context);
  assertTokenScope(context, env, 'admin:*');
  return context;
}

export function devAdminContext(env: Env): AuthContext {
  const projectId = defaultProjectId(env);
  return {
    actor_id: 'admin',
    actor_email: 'admin@example.local',
    role: 'admin',
    project_ids: [projectId],
    project_roles: { [projectId]: 'owner' },
    memberships: [{ project_id: projectId, role: 'owner' }],
    token_type: 'dev_admin',
    token_scopes: ['*'],
    token_expires_at: null,
  };
}

export function defaultProjectId(env: Env): string {
  return env.DEFAULT_PROJECT_ID || 'project-default';
}

export function canAccessProject(context: AuthContext, projectId: string, minimumRole: ProjectRole = 'reader'): boolean {
  const role = context.project_roles[projectId];
  if (!role) return false;
  return PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[minimumRole];
}

export function assertProjectAccess(context: AuthContext, projectId: string): void {
  assertProjectRead(context, projectId);
}

export function assertProjectRead(context: AuthContext, projectId: string): void {
  if (!canAccessProject(context, projectId, 'reader')) throw new HttpError(403, `project access denied: ${projectId}`);
}

export function assertProjectWrite(context: AuthContext, projectId: string): void {
  if (!canAccessProject(context, projectId, 'operator')) throw new HttpError(403, `project write denied: ${projectId}`);
}

export function assertGlobalAdmin(context: AuthContext): void {
  if (context.role !== 'admin') throw new HttpError(403, 'global admin role required');
}

export function hasTokenScope(context: AuthContext, required: TokenScope): boolean {
  if (context.token_type === 'dev_admin') return true;
  const scopes = new Set(context.token_scopes);
  if (scopes.has('*')) return true;
  if (required.startsWith('admin:') && scopes.has('admin:*')) return true;
  if (scopes.has(required)) return true;
  return required === 'tasks:read' && scopes.has('tasks:write');
}

export function assertTokenScope(context: AuthContext, env: Env, required: TokenScope): void {
  if (hasTokenScope(context, required)) return;
  if (env.TOKEN_SCOPE_ENFORCEMENT !== 'enforce') {
    console.warn(JSON.stringify({
      event: 'auth.scope.report_only',
      actor_id: context.actor_id,
      token_id: context.token_id ?? null,
      required_scope: required,
    }));
    return;
  }
  throw new HttpError(403, `token scope required: ${required}`);
}

export function projectFilter(context: AuthContext, alias = 't'): ProjectFilter {
  const ids = context.project_ids.length ? context.project_ids : ['__none__'];
  return {
    sql: `${alias}.project_id IN (${ids.map(() => '?').join(', ')})`,
    bindings: ids,
  };
}

export function sanitizedAuthContext(context: AuthContext): Record<string, unknown> {
  return {
    actor_id: context.actor_id,
    actor_email: context.actor_email,
    role: context.role,
    token_type: context.token_type,
    token_id: context.token_id,
    token_scopes: context.token_scopes,
    token_expires_at: context.token_expires_at ?? null,
    memberships: context.memberships,
    project_ids: context.project_ids,
    project_roles: context.project_roles,
  };
}

export async function auditDenied(env: Env, context: AuthContext | null, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  try {
    const projectId = await resolveDeniedProjectId(env, entityType, entityId, metadata);
    await env.DB.prepare(`
      INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, project_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId('audit'),
      context?.actor_id ?? 'anonymous',
      action,
      entityType,
      entityId,
      projectId,
      JSON.stringify({ ...metadata, denied: true }),
      nowIso(),
    ).run();
  } catch {
    // Denial audit is best-effort; never mask the authorization decision.
  }
}

async function resolveDeniedProjectId(env: Env, entityType: string, entityId: string, metadata: Record<string, unknown>): Promise<string | null> {
  if (typeof metadata.project_id === 'string' && metadata.project_id) return metadata.project_id;
  if (entityType === 'project') return entityId;
  if (entityType === 'task' && entityId !== 'collection') {
    const row = await env.DB.prepare('SELECT project_id FROM tasks WHERE id = ?').bind(entityId).first<{ project_id: string }>();
    return row?.project_id ?? null;
  }
  if (entityType === 'artifact') {
    const row = await env.DB.prepare(`
      SELECT t.project_id FROM artifacts ar INNER JOIN tasks t ON t.id = ar.task_id WHERE ar.id = ?
    `).bind(entityId).first<{ project_id: string }>();
    return row?.project_id ?? null;
  }
  return null;
}

export function bearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export async function hashBearerToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requireApiTokenContext(token: string, env: Env): Promise<AuthContext> {
  const tokenHash = await hashBearerToken(token);
  let tokenRow: TokenRow | null;
  try {
    tokenRow = await env.DB.prepare(`
      SELECT tok.id AS token_id,
        tok.user_id,
        tok.token_hash,
        tok.scopes_json,
        tok.expires_at,
        tok.revoked_at,
        u.role AS user_role,
        COALESCE(u.status, 'active') AS user_status,
        u.email AS email
      FROM api_tokens tok
      INNER JOIN users u ON u.id = tok.user_id
      WHERE tok.token_hash = ?
      LIMIT 1
    `).bind(tokenHash).first<TokenRow>();
  } catch {
    throw new HttpError(401, 'missing or invalid bearer token');
  }

  if (!tokenRow) throw new HttpError(401, 'missing or invalid bearer token');
  if (tokenRow.user_status && tokenRow.user_status !== 'active') throw new HttpError(401, 'user is disabled');
  if (tokenRow.revoked_at) throw new HttpError(401, 'token is revoked');
  if (tokenRow.expires_at && Date.parse(tokenRow.expires_at) <= Date.now()) throw new HttpError(401, 'token is expired');

  const membershipsResult = await env.DB.prepare(`
    SELECT project_id, role
    FROM project_memberships
    WHERE user_id = ? AND status = 'active'
    ORDER BY project_id ASC
  `).bind(tokenRow.user_id).all<MembershipRow>();
  const memberships = (membershipsResult.results ?? []).map((row) => ({
    project_id: String(row.project_id),
    role: normalizeProjectRole(row.role),
  }));
  const projectRoles = Object.fromEntries(memberships.map((membership) => [membership.project_id, membership.role]));
  const scopes = parseScopes(tokenRow.scopes_json);
  await touchTokenLastUsed(env, tokenRow.token_id);

  return {
    actor_id: tokenRow.user_id,
    actor_email: tokenRow.email,
    role: normalizeAuthRole(tokenRow.user_role),
    project_ids: memberships.map((membership) => membership.project_id),
    project_roles: projectRoles,
    memberships,
    token_type: 'api_token',
    token_id: tokenRow.token_id,
    token_scopes: scopes,
    token_expires_at: tokenRow.expires_at,
  };
}

async function touchTokenLastUsed(env: Env, tokenId: string): Promise<void> {
  try {
    await env.DB.prepare('UPDATE api_tokens SET last_used_at = ?, updated_at = ? WHERE id = ?').bind(nowIso(), nowIso(), tokenId).run();
  } catch {
    // Last-used tracking is operational metadata; never fail an otherwise valid auth decision.
  }
}

function parseScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((scope) => typeof scope === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeAuthRole(value: string): AuthRole {
  return value === 'admin' ? 'admin' : 'reader';
}

function normalizeProjectRole(value: string): ProjectRole {
  return value === 'owner' || value === 'admin' || value === 'operator' || value === 'reader' ? value : 'reader';
}
