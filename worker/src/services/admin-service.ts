import type { AuthContext } from '../auth';
import type { Env } from '../env';
import { hashBearerToken } from '../auth';
import { newId, nowIso } from '../ids';
import { HttpError } from '../response';
import { writeAudit } from './audit-service';

const ALLOWED_SCOPES = new Set(['*', 'tasks:read', 'tasks:write', 'artifacts:read', 'search:read', 'admin:*']);

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  scopes_json: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface CreateUserInput {
  email?: string;
  role?: string;
  status?: string;
}

export interface CreateTokenInput {
  user_id?: string;
  name?: string;
  scopes?: string[];
  expires_at?: string | null;
}

export async function listUsers(env: Env, url: URL): Promise<unknown> {
  const { page, pageSize, offset } = pagination(url);
  const q = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
  const result = q
    ? await env.DB.prepare(`
        SELECT id, email, role, status, created_at, updated_at
        FROM users WHERE lower(email) LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).bind(`%${q}%`, pageSize, offset).all()
    : await env.DB.prepare(`
        SELECT id, email, role, status, created_at, updated_at
        FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).bind(pageSize, offset).all();
  return { page, page_size: pageSize, items: result.results };
}

export async function createUser(env: Env, actor: AuthContext, input: CreateUserInput): Promise<unknown> {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'valid email is required');
  const role = input.role === 'admin' ? 'admin' : input.role === undefined || input.role === 'reader' ? 'reader' : null;
  if (!role) throw new HttpError(400, 'role must be admin or reader');
  const status = input.status === undefined || input.status === 'active' ? 'active' : input.status === 'disabled' ? 'disabled' : null;
  if (!status) throw new HttpError(400, 'status must be active or disabled');
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) throw new HttpError(409, 'user email already exists');
  const id = newId('user');
  const now = nowIso();
  await env.DB.prepare(`
    INSERT INTO users (id, email, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, email, role, status, now, now).run();
  await writeAudit(env, { actor: actor.actor_id, action: 'user.create', entity_type: 'user', entity_id: id, metadata: { email, role, status } });
  return { id, email, role, status, created_at: now };
}

export async function listTokens(env: Env, url: URL): Promise<unknown> {
  const { page, pageSize, offset } = pagination(url);
  const userId = url.searchParams.get('user_id')?.trim();
  const result = userId
    ? await env.DB.prepare(`
        SELECT t.id, t.user_id, u.email, t.name, t.scopes_json, t.expires_at, t.revoked_at,
          t.last_used_at, t.rotated_from_token_id, t.created_at, t.updated_at
        FROM api_tokens t INNER JOIN users u ON u.id = t.user_id
        WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT ? OFFSET ?
      `).bind(userId, pageSize, offset).all()
    : await env.DB.prepare(`
        SELECT t.id, t.user_id, u.email, t.name, t.scopes_json, t.expires_at, t.revoked_at,
          t.last_used_at, t.rotated_from_token_id, t.created_at, t.updated_at
        FROM api_tokens t INNER JOIN users u ON u.id = t.user_id
        ORDER BY t.created_at DESC LIMIT ? OFFSET ?
      `).bind(pageSize, offset).all();
  return { page, page_size: pageSize, items: result.results };
}

export async function createToken(env: Env, actor: AuthContext, input: CreateTokenInput): Promise<unknown> {
  const userId = String(input.user_id ?? '').trim();
  const name = String(input.name ?? '').trim();
  if (!userId) throw new HttpError(400, 'user_id is required');
  if (!name || name.length > 100) throw new HttpError(400, 'name is required and must not exceed 100 characters');
  const user = await env.DB.prepare(`SELECT id, status FROM users WHERE id = ?`).bind(userId).first<{ id: string; status: string }>();
  if (!user) throw new HttpError(404, 'user not found');
  if (user.status !== 'active') throw new HttpError(409, 'cannot create token for disabled user');
  const scopes = normalizeScopes(input.scopes);
  const expiresAt = normalizeExpiry(input.expires_at);
  return insertToken(env, actor, { userId, name, scopes, expiresAt, rotatedFrom: null, action: 'token.create' });
}

export async function rotateToken(env: Env, actor: AuthContext, tokenId: string): Promise<unknown> {
  const row = await env.DB.prepare(`
    SELECT id, user_id, name, scopes_json, expires_at, revoked_at FROM api_tokens WHERE id = ?
  `).bind(tokenId).first<TokenRow>();
  if (!row) throw new HttpError(404, 'token not found');
  if (row.revoked_at) throw new HttpError(409, 'token is already revoked');
  const scopes = normalizeScopes(parseStringArray(row.scopes_json));
  const expiresAt = normalizeExpiry(row.expires_at);
  const now = nowIso();
  const material = await newTokenMaterial();
  const newTokenId = newId('token');
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE api_tokens SET revoked_at = ?, rotation_claim = ?, updated_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).bind(now, newTokenId, now, tokenId),
    env.DB.prepare(`
      INSERT INTO api_tokens (id, user_id, token_hash, name, scopes_json, expires_at, revoked_at, last_used_at, rotated_from_token_id, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM api_tokens WHERE id = ? AND rotation_claim = ?)
    `).bind(newTokenId, row.user_id, material.hash, row.name, JSON.stringify(scopes), expiresAt, tokenId, now, now, tokenId, newTokenId),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) === 0 || Number(results[1]?.meta?.changes ?? 0) === 0) {
    throw new HttpError(409, 'token was rotated or revoked concurrently');
  }
  await writeAudit(env, { actor: actor.actor_id, action: 'token.rotate', entity_type: 'api_token', entity_id: newTokenId, metadata: { revoked_token_id: tokenId, user_id: row.user_id, scopes } });
  return { id: newTokenId, token: material.raw, user_id: row.user_id, name: row.name, scopes, expires_at: expiresAt, rotated_from_token_id: tokenId, created_at: now };
}

export async function revokeToken(env: Env, actor: AuthContext, tokenId: string): Promise<unknown> {
  const row = await env.DB.prepare('SELECT id, user_id, revoked_at FROM api_tokens WHERE id = ?').bind(tokenId).first<{ id: string; user_id: string; revoked_at: string | null }>();
  if (!row) throw new HttpError(404, 'token not found');
  const now = row.revoked_at ?? nowIso();
  if (!row.revoked_at) await env.DB.prepare('UPDATE api_tokens SET revoked_at = ?, updated_at = ? WHERE id = ?').bind(now, now, tokenId).run();
  await writeAudit(env, { actor: actor.actor_id, action: 'token.revoke', entity_type: 'api_token', entity_id: tokenId, metadata: { user_id: row.user_id, already_revoked: Boolean(row.revoked_at) } });
  return { id: tokenId, revoked_at: now };
}

export async function listAuditLogs(env: Env, url: URL): Promise<unknown> {
  const { page, pageSize, offset } = pagination(url, 100);
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  for (const [param, column] of [['actor', 'actor'], ['action', 'action'], ['entity_type', 'entity_type'], ['entity_id', 'entity_id'], ['project_id', 'project_id']] as const) {
    const value = url.searchParams.get(param)?.trim();
    if (value) {
      clauses.push(`${column} = ?`);
      bindings.push(value);
    }
  }
  const from = normalizeOptionalDate(url.searchParams.get('from'));
  const to = normalizeOptionalDate(url.searchParams.get('to'));
  if (from) { clauses.push('created_at >= ?'); bindings.push(from); }
  if (to) { clauses.push('created_at <= ?'); bindings.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await env.DB.prepare(`
    SELECT id, actor, action, entity_type, entity_id, project_id, metadata_json, created_at
    FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).bind(...bindings, pageSize, offset).all();
  return { page, page_size: pageSize, items: result.results };
}

export async function operationsSummary(env: Env): Promise<unknown> {
  const [tasks, runs, deadletters, cleanup] = await Promise.all([
    env.DB.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY status').all(),
    env.DB.prepare(`SELECT status, COUNT(*) AS count FROM agent_runs WHERE created_at >= datetime('now', '-24 hours') GROUP BY status ORDER BY status`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE deadletter_reason IS NOT NULL`).first<{ count: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM agent_runs WHERE provider_cleanup_completed_at IS NULL AND provider_cleanup_attempts > 0`).first<{ count: number }>(),
  ]);
  return {
    generated_at: nowIso(),
    tasks_by_status: tasks.results,
    agent_runs_last_24h_by_status: runs.results,
    deadlettered_tasks: Number(deadletters?.count ?? 0),
    provider_cleanup_failures: Number(cleanup?.count ?? 0),
  };
}

async function insertToken(env: Env, actor: AuthContext, input: { userId: string; name: string; scopes: string[]; expiresAt: string | null; rotatedFrom: string | null; action: string }): Promise<unknown> {
  const id = newId('token');
  const now = nowIso();
  const material = await newTokenMaterial();
  await env.DB.prepare(`
    INSERT INTO api_tokens (id, user_id, token_hash, name, scopes_json, expires_at, revoked_at, last_used_at, rotated_from_token_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
  `).bind(id, input.userId, material.hash, input.name, JSON.stringify(input.scopes), input.expiresAt, input.rotatedFrom, now, now).run();
  await writeAudit(env, { actor: actor.actor_id, action: input.action, entity_type: 'api_token', entity_id: id, metadata: { user_id: input.userId, scopes: input.scopes, expires_at: input.expiresAt } });
  return { id, token: material.raw, user_id: input.userId, name: input.name, scopes: input.scopes, expires_at: input.expiresAt, created_at: now };
}

async function newTokenMaterial(): Promise<{ raw: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const raw = `scan_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')}`;
  return { raw, hash: await hashBearerToken(raw) };
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, 'scopes must be a non-empty array');
  const scopes = [...new Set(value.map((scope) => String(scope).trim()).filter(Boolean))];
  for (const scope of scopes) if (!ALLOWED_SCOPES.has(scope)) throw new HttpError(400, `unsupported token scope: ${scope}`);
  return scopes;
}

function normalizeExpiry(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new HttpError(400, 'expires_at must be a future timestamp');
  return date.toISOString();
}

function normalizeOptionalDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new HttpError(400, 'invalid audit date filter');
  return date.toISOString();
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function pagination(url: URL, max = 100): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page') ?? 1) || 1));
  const pageSize = Math.min(max, Math.max(1, Math.floor(Number(url.searchParams.get('page_size') ?? 20) || 20)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
