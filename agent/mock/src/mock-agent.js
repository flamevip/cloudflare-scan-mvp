const env = readEnv();
const assetKey = `https:www.${env.TARGET}:443`;

await post('/api/agent/heartbeat', {
  task_id: env.TASK_ID,
  shard_id: env.SHARD_ID,
  agent_run_id: env.AGENT_RUN_ID,
});

await post('/api/agent/ingest', {
  task_id: env.TASK_ID,
  shard_id: env.SHARD_ID,
  agent_run_id: env.AGENT_RUN_ID,
  assets: [{
    asset_key: assetKey,
    url: `https://www.${env.TARGET}`,
    host: `www.${env.TARGET}`,
    ip: '93.184.216.34',
    port: 443,
    scheme: 'https',
    title: `Mock ${env.TARGET}`,
    status_code: 200,
    technologies: ['mock-server'],
  }],
  findings: [{
    unique_key: `${assetKey}:mock-template`,
    asset_key: assetKey,
    severity: 'info',
    title: 'Mock finding',
    template_id: 'mock-template',
    matched_at: `https://www.${env.TARGET}/`,
  }],
  artifacts: [{
    type: 'mock_raw',
    raw_content: JSON.stringify({ url: `https://www.${env.TARGET}`, status_code: 200, title: `Mock ${env.TARGET}` }) + '\n',
    search_content: `# Mock asset for ${env.TARGET}\n\nURL: https://www.${env.TARGET}\nStatus: 200\n`,
    sha256: 'mock',
    size: 123,
  }],
});

await post('/api/agent/complete', {
  task_id: env.TASK_ID,
  shard_id: env.SHARD_ID,
  agent_run_id: env.AGENT_RUN_ID,
});

console.log(`mock agent completed task ${env.TASK_ID}`);

function readEnv() {
  const input = {
    TASK_ID: process.env.TASK_ID ?? '',
    SHARD_ID: process.env.SHARD_ID ?? '',
    AGENT_RUN_ID: process.env.AGENT_RUN_ID ?? '',
    CALLBACK_BASE_URL: process.env.CALLBACK_BASE_URL ?? 'http://localhost:8787',
    CALLBACK_TOKEN: process.env.CALLBACK_TOKEN ?? '',
    TARGET: process.env.TARGET ?? 'example.com',
  };
  for (const [key, value] of Object.entries(input)) {
    if (!value) throw new Error(`${key} is required`);
  }
  return input;
}

async function post(path, body) {
  const response = await fetch(`${env.CALLBACK_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CALLBACK_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  console.log(`${path}: ${text}`);
}
