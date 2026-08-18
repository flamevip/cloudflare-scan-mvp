import { createHash, createHmac, randomUUID } from 'node:crypto';

const mode = process.argv[2];
if (!['create', 'revoke'].includes(mode)) throw new Error('usage: manage-console-acceptance-fixture.mjs create|revoke');

const accountId = required('CLOUDFLARE_ACCOUNT_ID');
const apiToken = required('CLOUDFLARE_API_TOKEN');
const databaseId = required('D1_DATABASE_ID');
const baseUrl = required('CONSOLE_BASE_URL').replace(/\/$/, '');
const environment = required('CONSOLE_ENVIRONMENT');
const runId = required('GITHUB_RUN_ID').replace(/[^0-9]/g, '');
const projectId = process.env.CONSOLE_PROJECT_ID?.trim() || 'project-default';
const taskId = `task_console_acceptance_${runId}`;
const shardId = `shard_console_acceptance_${runId}`;
const agentRunId = `run_console_acceptance_${runId}`;
const prefix = `tenants/default/tasks/${taskId}`;
const rawKey = `${prefix}/raw/console-acceptance.jsonl`;
const searchKey = `${prefix}/search/console-acceptance.md`;
const now = new Date().toISOString();

if (!['staging', 'pilot'].includes(environment)) throw new Error('CONSOLE_ENVIRONMENT must be staging or pilot');

if (mode === 'create') {
  const agentSecret = required('AGENT_TOKEN_SECRET');
  await query(`
    INSERT INTO tasks (
      id, project_id, name, status, targets_json, modules_json, external_sources_json,
      target_count, max_agents, rate_limit, timeout_minutes, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, 'running', '["70yun.xyz"]', '["subdomain","http_probe","nuclei"]', '[]', 1, 1, 1, 15, 'github-actions', ?, ?)
  `, [taskId, projectId, `${environment} console artifact acceptance`, now, now]);
  await query(`
    INSERT INTO task_shards (
      id, task_id, module, status, target_count, retry_count, max_retry,
      agent_run_id, started_at, created_at, updated_at
    ) VALUES (?, ?, 'console_acceptance', 'running', 1, 0, 0, ?, ?, ?, ?)
  `, [shardId, taskId, agentRunId, now, now, now]);
  await query(`
    INSERT INTO agent_runs (
      id, task_id, shard_id, provider, provider_job_id, status, image, region,
      started_at, last_heartbeat_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'mock_inline', ?, 'running', 'console-acceptance-fixture', 'ci', ?, ?, ?, ?)
  `, [agentRunId, taskId, shardId, `fixture:${runId}`, now, now, now, now]);

  const rawContent = `${JSON.stringify({ type: 'console_acceptance', target: '70yun.xyz', environment, run_id: runId })}\n`;
  const searchContent = `# Console acceptance artifact\n\nEnvironment: ${environment}\nTarget: 70yun.xyz\nRun: ${runId}\n`;
  const identity = { task_id: taskId, shard_id: shardId, agent_run_id: agentRunId, exp: Math.floor(Date.now() / 1000) + 15 * 60 };
  const agentToken = signAgentToken(identity, agentSecret);
  await workerApi('/api/agent/ingest', agentToken, {
    ...identity,
    artifacts: [{
      type: 'console_acceptance', raw_r2_key: rawKey, search_r2_key: searchKey,
      raw_content: rawContent, search_content: searchContent,
      sha256: createHash('sha256').update(rawContent).digest('hex'), size: Buffer.byteLength(rawContent),
    }],
  });
  await workerApi('/api/agent/complete', agentToken, identity);
  const artifact = await queryOne('SELECT id, raw_r2_key, search_r2_key FROM artifacts WHERE task_id = ? LIMIT 1', [taskId]);
  if (!artifact || artifact.raw_r2_key !== rawKey || artifact.search_r2_key !== searchKey) throw new Error('console acceptance artifact was not persisted as expected');
  await audit('console.acceptance.fixture.create', { environment, run_id: runId, task_id: taskId, artifact_id: artifact.id });
  console.log(JSON.stringify({ event: 'console.acceptance.fixture_created', environment, task_id: taskId, artifact_id: artifact.id }));
} else {
  await query('DELETE FROM artifacts WHERE task_id = ?', [taskId]);
  await query('DELETE FROM findings WHERE task_id = ?', [taskId]);
  await query('DELETE FROM assets WHERE task_id = ?', [taskId]);
  await query('DELETE FROM agent_runs WHERE task_id = ?', [taskId]);
  await query('DELETE FROM task_shards WHERE task_id = ?', [taskId]);
  await query('DELETE FROM tasks WHERE id = ? AND created_by = \'github-actions\'', [taskId]);
  await audit('console.acceptance.fixture.revoke', { environment, run_id: runId, task_id: taskId, r2_cleanup_confirmed: true });
  console.log(JSON.stringify({ event: 'console.acceptance.fixture_revoked', environment, task_id: taskId }));
}

function signAgentToken(identity, secret) {
  const payload = Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

async function workerApi(path, token, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = await response.json().catch(() => null);
  if (!response.ok || !envelope || Number(envelope.code) >= 400) {
    throw new Error(`${path} failed: HTTP ${response.status}: ${envelope?.message ?? 'invalid response'}`);
  }
  return envelope.data;
}

async function audit(action, metadata) {
  await query(`
    INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, project_id, metadata_json, created_at)
    VALUES (?, 'github-actions', ?, 'console_acceptance_fixture', ?, ?, ?, ?)
  `, [`audit_${randomUUID()}`, action, taskId, projectId, JSON.stringify(metadata), now]);
}

async function queryOne(sql, params) {
  const result = await query(sql, params);
  return result?.[0]?.results?.[0] ?? null;
}

async function query(sql, params) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${response.status}` }] }));
  if (!response.ok || payload.success !== true) {
    const message = payload.errors?.map((error) => error.message).join('; ') || `HTTP ${response.status}`;
    throw new Error(`D1 query failed: ${message}`);
  }
  return payload.result;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
