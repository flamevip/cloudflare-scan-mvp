import type { Env } from '../env';
import { requireAdminContext } from '../auth';
import { ok, HttpError } from '../response';
import { sweepTimedOutAgentRuns } from '../services/timeout-service';
import { sweepRetention } from '../services/retention-service';
import { readJson } from '../response';

export async function handleMaintenance(request: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith('/api/admin/maintenance/')) return null;
  await requireAdminContext(request, env);
  if (request.method !== 'POST') throw new HttpError(405, 'method not allowed');
  if (path === '/api/admin/maintenance/timeouts') return ok(await sweepTimedOutAgentRuns(env));
  if (path === '/api/admin/maintenance/retention') {
    const body = await readJson<{ dry_run?: boolean }>(request);
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') throw new HttpError(400, 'dry_run must be a boolean');
    return ok(await sweepRetention(env, { dry_run: body.dry_run !== false }));
  }
  throw new HttpError(404, 'maintenance route not found');
}
