import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = await mkdtemp(resolve(tmpdir(), 'scan-wrangler-render-'));
const output = resolve(work, 'wrangler.staging.toml');
const baseEnv = {
  ...process.env,
  WORKER_NAME: 'scan-staging',
  WORKER_CUSTOM_DOMAIN: 'scan-staging.example.test',
  ENVIRONMENT: 'staging',
  TOKEN_SCOPE_ENFORCEMENT: 'report',
  CALLBACK_BASE_URL: 'https://scan-staging.example.test',
  AGENT_SCAN_MODE: 'mock',
  AGENT_MAX_CANDIDATES: '100',
  TASK_MAX_RETRY: '1',
  TENCENT_EKS_CI_REGION: 'ap-shanghai',
  TENCENT_EKS_CI_VPC_ID: 'vpc-fixture',
  TENCENT_EKS_CI_SUBNET_ID: 'subnet-fixture',
  TENCENT_EKS_CI_SECURITY_GROUP_IDS: 'sg-fixture',
  TENCENT_EKS_CI_IMAGE: `ghcr.io/flamevip/cloudflare-scan-mvp-agent@sha256:${'a'.repeat(64)}`,
  TENCENT_EKS_CI_ALLOWED_REGISTRY_HOST: 'ghcr.io',
  TENCENT_EKS_CI_AUTO_CREATE_EIP: 'true',
  TENCENT_EKS_CI_EIP_BANDWIDTH_MBPS: '5',
  TENCENT_EKS_CI_EIP_ISP: 'BGP',
  TENCENT_EKS_CI_DRY_RUN: 'true',
  D1_DATABASE_NAME: 'scan-staging',
  D1_DATABASE_ID: '00000000-0000-0000-0000-000000000001',
  R2_BUCKET_NAME: 'scan-staging-artifacts',
  AI_SEARCH_INSTANCE_NAME: 'scan-staging-search',
  SCAN_QUEUE_NAME: 'scan-staging-queue',
  DEADLETTER_QUEUE_NAME: 'scan-staging-deadletter',
};

try {
  const rendered = run(baseEnv, output);
  assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  const toml = await readFile(output, 'utf8');
  assert.doesNotMatch(toml, /\{\{[A-Z0-9_]+\}\}/);
  assert.match(toml, /main = "\.\.\/worker\/src\/index\.ts"/, 'rendered config must resolve the Worker entry point from work/');
  assert.match(toml, /migrations_dir = "\.\.\/migrations\/d1"/, 'rendered config must resolve migrations from work/');
  assert.match(toml, /\[assets\][\s\S]*directory = "\.\.\/web\/dist"/, 'rendered config must resolve built web assets from work/');
  assert.match(toml, /not_found_handling = "single-page-application"/);
  assert.match(toml, /run_worker_first = \["\/api\/\*", "\/health"\]/, 'API and health paths must never be handled by the SPA fallback');
  assert.match(toml, /routes = \[\{ pattern = "scan-staging\.example\.test", custom_domain = true \}\]/);
  assert.doesNotMatch(toml, /DEV_ADMIN_TOKEN/, 'remote config must not ship a development admin token binding');
  assert.match(toml, /TOKEN_SCOPE_ENFORCEMENT = "report"/);
  assert.match(toml, /TASK_MAX_RETRY = "1"/);
  assert.match(toml, /TENCENT_EKS_CI_DRY_RUN = "true"/);
  assert.match(toml, /TENCENT_EKS_CI_AUTO_CREATE_EIP = "true"/);
  assert.doesNotMatch(toml, /TENCENT_TCR_|tencentcloudcr/);

  const unpinned = run({ ...baseEnv, TENCENT_EKS_CI_IMAGE: 'registry.example.test/scan-agent:latest' }, resolve(work, 'invalid-image.toml'));
  assert.notEqual(unpinned.status, 0);
  assert.match(unpinned.stderr, /pinned by sha256 digest/);

  const mismatchedCallback = run({ ...baseEnv, CALLBACK_BASE_URL: 'https://other.example.test' }, resolve(work, 'invalid-callback.toml'));
  assert.notEqual(mismatchedCallback.status, 0);
  assert.match(mismatchedCallback.stderr, /HTTPS origin of WORKER_CUSTOM_DOMAIN/);

  const workersDevDomain = run({ ...baseEnv, WORKER_CUSTOM_DOMAIN: 'scan-staging.example.workers.dev', CALLBACK_BASE_URL: 'https://scan-staging.example.workers.dev' }, resolve(work, 'invalid-workers-dev.toml'));
  assert.notEqual(workersDevDomain.status, 0);
  assert.match(workersDevDomain.stderr, /must not use workers\.dev/);

  const unsafePilot = run({ ...baseEnv, ENVIRONMENT: 'pilot', TOKEN_SCOPE_ENFORCEMENT: 'report', AGENT_SCAN_MODE: 'real_toolchain' }, resolve(work, 'invalid-pilot.toml'));
  assert.notEqual(unsafePilot.status, 0);
  assert.match(unsafePilot.stderr, /must be enforce for pilot/);

  const retryingPilot = run({ ...baseEnv, ENVIRONMENT: 'pilot', TOKEN_SCOPE_ENFORCEMENT: 'enforce', AGENT_SCAN_MODE: 'real_toolchain', TASK_MAX_RETRY: '1' }, resolve(work, 'invalid-pilot-retry.toml'));
  assert.notEqual(retryingPilot.status, 0);
  assert.match(retryingPilot.stderr, /TASK_MAX_RETRY must be 0 for pilot/);

  const injected = run({ ...baseEnv, WORKER_NAME: 'scan-staging\ncompatibility_date = "1999-01-01"' }, resolve(work, 'injected.toml'));
  assert.notEqual(injected.status, 0);
  assert.match(injected.stderr, /forbidden control character/);

  console.log(JSON.stringify({ ok: true, environments: ['staging', 'pilot'], digest_pinning: true, pilot_scope_enforcement: true, control_character_rejection: true, network: 'not used', cloud_credentials: 'not used' }, null, 2));
} finally {
  await rm(work, { recursive: true, force: true });
}

function run(env, outputPath) {
  return spawnSync(process.execPath, ['scripts/render-wrangler-config.mjs', 'config/wrangler.tencent.template.toml', outputPath], { cwd: root, env, encoding: 'utf8' });
}
