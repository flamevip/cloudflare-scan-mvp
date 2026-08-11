import type { Env } from '../env';
import { ok } from '../response';

export async function handleHealth(_request: Request, env: Env): Promise<Response> {
  return ok({ service: 'scan-mvp-api', env: env.ENV, time: new Date().toISOString() });
}
