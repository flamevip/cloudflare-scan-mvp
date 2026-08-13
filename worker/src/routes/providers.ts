import type { Env } from '../env';
import { requireAdminContext } from '../auth';
import { ok, readJson, HttpError } from '../response';
import { buildProviderPreflight, type ProviderPreflightInput } from '../services/provider-preflight';
import { newId, nowIso } from '../ids';

export async function handleProviders(request: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith('/api/admin/providers/')) return null;
  await requireAdminContext(request, env);
  if (request.method !== 'POST') throw new HttpError(405, 'method not allowed');
  if (path === '/api/admin/providers/preflight') {
    const body = await readJson<ProviderPreflightInput>(request);
    return ok(await buildProviderPreflight(env, body));
  }
  if (path === '/api/admin/providers/consumer-canary') {
    const nonce = newId('canary');
    await env.SCAN_DISPATCH.send({ type: 'deployment.canary', nonce, created_at: nowIso() });
    return ok({ nonce, status: 'queued' });
  }
  throw new HttpError(404, 'provider route not found');
}
