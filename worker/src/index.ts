import type { Env } from './env';
import type { ScanDispatchMessage } from './types/queue';
import { handleErrors, error } from './response';
import { handleHealth } from './routes/health';
import { handleTasks } from './routes/tasks';
import { handleAssets } from './routes/assets';
import { handleFindings } from './routes/findings';
import { handleArtifacts } from './routes/artifacts';
import { handleAgent } from './routes/agent';
import { handleMaintenance } from './routes/maintenance';
import { handleSearch } from './routes/search';
import { handleProjects } from './routes/projects';
import { handleProviders } from './routes/providers';
import { handleAdmin } from './routes/admin';
import { processDispatchMessage } from './queue/consumer';
import { sweepTimedOutAgentRuns } from './services/timeout-service';
import { sweepProviderCleanup } from './services/provider-cleanup-service';
import { sweepRetention } from './services/retention-service';
import { sweepProviderDiagnostics } from './services/provider-diagnostics-service';

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
    const response = await handleErrors(async () => {
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);

      if (path === '/health' && request.method === 'GET') return handleHealth(request, env);

      const handlers = [
        () => handleAgent(request, env, path, context, requestId),
        () => handleMaintenance(request, env, path),
        () => handleSearch(request, env, url, path),
        () => handleProviders(request, env, path),
        () => handleAdmin(request, env, url, path),
        () => handleProjects(request, env, path),
        () => handleTasks(request, env, url, path),
        () => handleAssets(request, env, url, path),
        () => handleFindings(request, env, url, path),
        () => handleArtifacts(request, env, url, path),
      ];

      for (const handler of handlers) {
        const response = await handler();
        if (response) return response;
      }

      return error(404, 'route not found');
    });
    console.log(JSON.stringify({
      event: 'http.request',
      request_id: requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      status: response.status,
      duration_ms: Date.now() - startedAt,
      environment: env.ENV,
    }));
    const headers = new Headers(response.headers);
    headers.set('X-Request-ID', requestId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },

  async queue(batch: MessageBatch<ScanDispatchMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      console.log(JSON.stringify({ event: 'queue.dispatch.start', task_id: message.body.task_id, attempt: message.body.attempt }));
      await processDispatchMessage(env, message.body);
      message.ack();
      console.log(JSON.stringify({ event: 'queue.dispatch.ack', task_id: message.body.task_id, attempt: message.body.attempt }));
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === '0 3 * * *') {
      const retention = await sweepRetention(env);
      console.log(JSON.stringify({ event: 'scheduled.retention', ...retention }));
      return;
    }
    const diagnostics = await sweepProviderDiagnostics(env);
    const timeouts = await sweepTimedOutAgentRuns(env);
    const cleanup = await sweepProviderCleanup(env);
    console.log(JSON.stringify({ event: 'scheduled.convergence', diagnostics, timeouts, cleanup }));
  },
};

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}
