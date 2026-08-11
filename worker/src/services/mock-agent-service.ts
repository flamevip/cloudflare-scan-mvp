import type { Env } from '../env';
import { ingestAgentPayload } from './ingest-service';
import { markCompleted, markRunning } from './state-machine';
import { taskPrefix } from './r2-service';

export async function runInlineMockAgent(env: Env, taskId: string, shardId: string, agentRunId: string, target: string): Promise<void> {
  await markRunning(env, taskId, shardId, agentRunId);
  const assetKey = `https:www.${target}:443`;
  await ingestAgentPayload(env, {
    task_id: taskId,
    shard_id: shardId,
    agent_run_id: agentRunId,
    assets: [{ asset_key: assetKey, url: `https://www.${target}`, host: `www.${target}`, ip: '93.184.216.34', port: 443, scheme: 'https', title: `Mock ${target}`, status_code: 200, technologies: ['mock-server'] }],
    findings: [{ unique_key: `${assetKey}:mock-template`, asset_key: assetKey, severity: 'info', title: 'Mock finding', template_id: 'mock-template', matched_at: `https://www.${target}/` }],
    artifacts: [{
      type: 'mock_raw',
      raw_r2_key: `${taskPrefix(taskId)}/raw/httpx/${shardId}.jsonl`,
      search_r2_key: `${taskPrefix(taskId)}/search/assets/${shardId}.md`,
      raw_content: JSON.stringify({ url: `https://www.${target}`, status_code: 200, title: `Mock ${target}` }) + '\n',
      search_content: `# Mock asset for ${target}\n\nURL: https://www.${target}\nStatus: 200\n`,
      sha256: 'mock',
      size: 123,
    }],
  });
  await markCompleted(env, taskId, shardId, agentRunId);
}
