import type { Env } from '../env';
import { requireAdminContext } from '../auth';
import { ok, readJson, HttpError } from '../response';
import { buildProviderPreflight, type ProviderPreflightInput } from '../services/provider-preflight';

export async function handleProviders(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== '/api/admin/providers/preflight') return null;
  await requireAdminContext(request, env);
  if (request.method !== 'POST') throw new HttpError(405, 'method not allowed');
  const body = await readJson<ProviderPreflightInput>(request);
  return ok(await buildProviderPreflight(env, body));
}
