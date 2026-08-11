import type { Env } from '../env';
import { requireAdminContext } from '../auth';
import { HttpError, ok, readJson } from '../response';
import {
  createToken,
  createUser,
  listAuditLogs,
  listTokens,
  listUsers,
  operationsSummary,
  revokeToken,
  rotateToken,
  type CreateTokenInput,
  type CreateUserInput,
} from '../services/admin-service';

export async function handleAdmin(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
  if (!path.startsWith('/api/admin/')) return null;
  if (path.startsWith('/api/admin/maintenance/') || path === '/api/admin/providers/preflight' || path === '/api/admin/search/status') return null;
  const context = await requireAdminContext(request, env);

  if (path === '/api/admin/users') {
    if (request.method === 'GET') return ok(await listUsers(env, url));
    if (request.method === 'POST') return ok(await createUser(env, context, await readJson<CreateUserInput>(request)), { status: 201 });
    throw new HttpError(405, 'method not allowed');
  }

  if (path === '/api/admin/tokens') {
    if (request.method === 'GET') return ok(await listTokens(env, url));
    if (request.method === 'POST') return ok(await createToken(env, context, await readJson<CreateTokenInput>(request)), { status: 201 });
    throw new HttpError(405, 'method not allowed');
  }

  const tokenMatch = path.match(/^\/api\/admin\/tokens\/([^/]+)\/(rotate|revoke)$/);
  if (tokenMatch) {
    if (request.method !== 'POST') throw new HttpError(405, 'method not allowed');
    return ok(tokenMatch[2] === 'rotate' ? await rotateToken(env, context, tokenMatch[1]) : await revokeToken(env, context, tokenMatch[1]));
  }

  if (path === '/api/admin/audit-logs') {
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    return ok(await listAuditLogs(env, url));
  }

  if (path === '/api/admin/operations/summary') {
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    return ok(await operationsSummary(env));
  }

  throw new HttpError(404, 'admin route not found');
}
