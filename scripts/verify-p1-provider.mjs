import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const providerErrors = loadTsModule('worker/src/services/provider-errors.ts');
const providerCost = loadTsModule('worker/src/services/provider-cost.ts');
const configValidation = loadTsModule('worker/src/services/config-validation.ts');
const cloudRunService = loadTsModule('worker/src/services/cloud-run-service.ts', {
  './provider-errors': providerErrors,
});
const aliyunService = loadTsModule('worker/src/services/aliyun-eci-service.ts', {
  './provider-errors': providerErrors,
});
const tencentService = loadTsModule('worker/src/services/tencent-eks-ci-service.ts', {
  './provider-errors': providerErrors,
});
const agentProvider = loadTsModule('worker/src/services/agent-provider.ts', {
  './aliyun-eci-service': aliyunService,
  './cloud-run-service': cloudRunService,
  './tencent-eks-ci-service': tencentService,
  './provider-cost': providerCost,
});
const providerPreflight = loadTsModule('worker/src/services/provider-preflight.ts', {
  './agent-provider': agentProvider,
  './config-validation': configValidation,
  './tencent-eks-ci-service': tencentService,
  './provider-errors': providerErrors,
});
const consumer = loadTsModule('worker/src/queue/consumer.ts', {
  '../ids': { newId: (prefix) => `${prefix}_test`, nowIso: () => '2026-06-15T00:00:00.000Z' },
  '../services/agent-token': { createAgentToken: async () => 'agent-token-redacted', agentTokenTtlSeconds: () => 900 },
  '../services/agent-provider': agentProvider,
  '../services/hunter-service': { runHunterEnrichment: async () => ({ status: 'skipped', retryable: false, message: 'disabled' }) },
  '../services/retry-policy': { decideRetry: (input) => input.retryable ? { action: 'retry', next_attempt: input.attempt + 1, reason: 'retryable fixture' } : { action: 'deadletter', next_attempt: null, reason: 'failure is not retryable' }, parseMaxRetry: () => 1 },
  '../services/mock-agent-service': { runInlineMockAgent: async () => undefined },
  '../services/state-machine': { markFailed: async () => undefined, markRetrying: async () => undefined },
  '../services/provider-errors': providerErrors,
  '../services/provider-cleanup-service': { cleanupProviderRun: async () => ({ attempted: true, completed: true, already_absent: false, error: null }) },
});
let cleanupMode = 'success';
const cleanupService = loadTsModule('worker/src/services/provider-cleanup-service.ts', {
  '../ids': { newId: (prefix) => `${prefix}_test`, nowIso: () => '2026-06-15T00:00:00.000Z' },
  './agent-provider': {
    deleteAgentProviderJob: async () => {
      if (cleanupMode === 'failure') throw providerErrors.classifyTencentProviderCode('InternalError.CmdTimeout', 500, 'cleanup timeout');
      return { deleted: true, already_absent: cleanupMode === 'absent' };
    },
  },
  './provider-errors': providerErrors,
});

const missingConfig = providerErrors.providerConfigMissing('gcp_cloud_run', 'GCP_PROJECT_ID');
assert.equal(missingConfig.category, 'config_missing');
assert.equal(missingConfig.retryable, false);
const cloud503 = providerErrors.classifyProviderHttpError('gcp_cloud_run', 'provider_response', 503, 'backend unavailable token=secret');
assert.equal(cloud503.category, 'transient');
assert.equal(cloud503.retryable, true);
assert.doesNotMatch(cloud503.safe_message, /secret/);
const cloud401 = providerErrors.classifyProviderHttpError('gcp_cloud_run', 'auth', 401, 'bad credentials');
assert.equal(cloud401.category, 'auth_failed');
assert.equal(cloud401.retryable, false);
const aliyunThrottle = providerErrors.classifyAliyunProviderCode('Throttling.User', 200, 'qps exceeded');
assert.equal(aliyunThrottle.category, 'rate_limited');
assert.equal(aliyunThrottle.retryable, true);
const aliyunInvalid = providerErrors.classifyAliyunProviderCode('InvalidParameter.SecurityGroupId', 400, 'invalid sg');
assert.equal(aliyunInvalid.category, 'validation');
assert.equal(aliyunInvalid.retryable, false);
const tencentAuth = providerErrors.classifyTencentProviderCode('AuthFailure.SignatureFailure', 200, 'SecretId=fixture Authorization=fixture', 'req-auth');
assert.equal(tencentAuth.category, 'auth_failed');
assert.equal(tencentAuth.retryable, false);
assert.doesNotMatch(tencentAuth.safe_message, /fixture/);
const tencentCamAuth = providerErrors.classifyTencentProviderCode('InternalError.CamNoAuth', 200, 'CAM denied', 'req-cam');
assert.equal(tencentCamAuth.category, 'auth_failed');
assert.equal(tencentCamAuth.retryable, false);
const tencentParam = providerErrors.classifyTencentProviderCode('InternalError.Param', 200, 'bad parameter', 'req-param');
assert.equal(tencentParam.category, 'validation');
assert.equal(tencentParam.retryable, false);
const tencentThrottle = providerErrors.classifyTencentProviderCode('RequestLimitExceeded', 200, 'too many requests', 'req-rate');
assert.equal(tencentThrottle.category, 'rate_limited');
assert.equal(tencentThrottle.retryable, true);
const tencentInvalid = providerErrors.classifyTencentProviderCode('InvalidParameter.SubnetId', 200, 'invalid subnet', 'req-invalid');
assert.equal(tencentInvalid.category, 'validation');
assert.equal(tencentInvalid.retryable, false);
const tencentQuota = providerErrors.classifyTencentProviderCode('ResourceInsufficient', 200, 'capacity unavailable', 'req-quota');
assert.equal(tencentQuota.category, 'quota');
assert.equal(tencentQuota.retryable, false);
const tencentTransient = providerErrors.classifyTencentProviderCode('InternalError.CmdTimeout', 500, 'temporary timeout', 'req-transient');
assert.equal(tencentTransient.category, 'transient');
assert.equal(tencentTransient.retryable, true);

const baseEnv = {
  AGENT_PROVIDER: 'auto',
  AGENT_AUTO_ROUTING_POLICY: 'region',
  AGENT_AUTO_ENABLE_FALLBACK: 'true',
  CALLBACK_BASE_URL: 'http://localhost:8787',
  CLOUD_RUN_DRY_RUN: 'true',
  GCP_PROJECT_ID: 'scan-mvp-dry-run',
  GCP_LOCATION: 'asia-east1',
  CLOUD_RUN_JOB_NAME: 'scan-agent-job',
  ALIYUN_ECI_DRY_RUN: 'true',
  ALIYUN_REGION_ID: 'cn-hangzhou',
  ALIYUN_SECURITY_GROUP_ID: 'sg-placeholder',
  ALIYUN_VSWITCH_ID: 'vsw-placeholder',
  ALIYUN_ECI_IMAGE: 'registry.example/scan-agent@sha256:abc',
  AGENT_SCAN_MODE: 'mock',
};
const aliyunParams = aliyunService.buildCreateContainerGroupParams(
  { ...baseEnv, ALIYUN_ZONE_ID: 'cn-hangzhou-f', ALIYUN_ECI_MEMORY: '2' },
  {
    task: { id: 'task_fixture', modules_json: '["http_probe"]', rate_limit: 1, timeout_minutes: 5 },
    shard_id: 'shard_fixture',
    agent_run_id: 'agent_run_fixture',
    callback_token: 'short-callback-token',
  },
  'cn-hangzhou',
  baseEnv.ALIYUN_ECI_IMAGE,
  'http://localhost:8787',
  'scan-task-fixture',
);
assert.equal(aliyunParams.ZoneId, 'cn-hangzhou-f');
assert.equal(aliyunParams.Memory, '2');
assert.equal(aliyunParams['Container.1.ImagePullPolicy'], 'Always');
assert.equal(aliyunParams['Container.1.EnvironmentVar.9.Key'], 'MODULES');
assert.equal(aliyunParams['Container.1.EnvironmentVar.9.Value'], 'http_probe');
assert.equal(aliyunParams['Container.1.EnvironmentVar.10.Key'], 'RATE_LIMIT');
assert.equal(Object.values(aliyunParams).every((value) => typeof value === 'string'), true);
assert.equal(Object.keys(aliyunParams).some((key) => aliyunParams[key] === 'MODULES_JSON'), false);
assert.throws(() => aliyunService.buildCreateContainerGroupParams(
  baseEnv,
  {
    task: { id: 'task_fixture', modules_json: '["http_probe"]', rate_limit: 1, timeout_minutes: 5 },
    shard_id: 'shard_fixture',
    agent_run_id: 'agent_run_fixture',
    callback_token: 'x'.repeat(257),
  },
  'cn-hangzhou',
  baseEnv.ALIYUN_ECI_IMAGE,
  'http://localhost:8787',
  'scan-task-fixture',
), /CALLBACK_TOKEN exceeds 256 characters/);

const tencentEnv = {
  ...baseEnv,
  ENV: 'dev',
  AGENT_PROVIDER: 'tencent_eks_ci',
  TENCENT_EKS_CI_REGION: 'ap-shanghai',
  TENCENT_EKS_CI_VPC_ID: 'vpc-fixture',
  TENCENT_EKS_CI_SUBNET_ID: 'subnet-fixture',
  TENCENT_EKS_CI_SECURITY_GROUP_IDS: 'sg-first,sg-second',
  TENCENT_EKS_CI_IMAGE: `ccr.ccs.tencentyun.com/scan-agent/scan-agent@sha256:${'a'.repeat(64)}`,
  TENCENT_EKS_CI_ALLOWED_REGISTRY_HOST: 'ccr.ccs.tencentyun.com',
  TENCENT_EKS_CI_CPU: '1',
  TENCENT_EKS_CI_MEMORY: '2',
  TENCENT_EKS_CI_DRY_RUN: 'true',
};
const tencentInput = {
  task: { id: 'task_fixture', modules_json: '["http_probe"]', rate_limit: 1, timeout_minutes: 5 },
  shard_id: 'shard_fixture',
  agent_run_id: 'agent_run_fixture',
  callback_token: 'short-callback-token',
};
const tencentRequest = tencentService.buildCreateEksContainerInstancesRequest(tencentEnv, tencentInput);
assert.equal(tencentRequest.Replicas, 1);
assert.equal(tencentRequest.RestartPolicy, 'Never');
assert.equal(tencentRequest.Containers.length, 1);
assert.equal(tencentRequest.Containers[0].Image, tencentEnv.TENCENT_EKS_CI_IMAGE);
assert.deepEqual(JSON.parse(JSON.stringify(tencentRequest.SecurityGroupIds)), ['sg-first', 'sg-second']);
assert.equal(tencentRequest.Containers[0].EnvironmentVars.find((item) => item.Name === 'MODULES')?.Value, 'http_probe');
assert.equal(tencentRequest.Containers[0].EnvironmentVars.find((item) => item.Name === 'CALLBACK_TOKEN')?.Value, 'short-callback-token');
assert.equal('Commands' in tencentRequest.Containers[0], false);
const tencentDryRun = await tencentService.launchTencentEksContainerInstance(tencentEnv, tencentInput);
assert.equal(tencentDryRun.dry_run, true);
assert.match(tencentDryRun.provider_job_id, /^dry-run:tencent-eks-ci\//);
const tencentDryDelete = await tencentService.deleteTencentEksContainerInstances(tencentEnv, [tencentDryRun.provider_job_id]);
assert.equal(tencentDryDelete.already_absent, true);
const tencentLiveEnv = {
  ...tencentEnv,
  TENCENT_EKS_CI_DRY_RUN: 'false',
  TENCENT_SECRET_ID: 'AKIDEXAMPLE',
  TENCENT_SECRET_KEY: 'SECRETKEYEXAMPLE',
};
const deleteActions = [];
const deletingTencentService = loadTsModule('worker/src/services/tencent-eks-ci-service.ts', {
  './provider-errors': providerErrors,
}, {
  fetch: async (_url, init) => {
    const action = new Headers(init.headers).get('X-TC-Action');
    deleteActions.push(action);
    if (action === 'DeleteEKSContainerInstances') return jsonResponse({ Response: { RequestId: 'req-delete' } });
    if (action === 'DescribeEKSContainerInstances') return jsonResponse({ Response: { RequestId: 'req-describe', TotalCount: 0, EksCis: [] } });
    throw new Error(`unexpected Tencent action ${action}`);
  },
});
const confirmedDelete = await deletingTencentService.deleteTencentEksContainerInstances(tencentLiveEnv, ['eksci-fixture']);
assert.deepEqual(deleteActions, ['DeleteEKSContainerInstances', 'DescribeEKSContainerInstances']);
assert.equal(confirmedDelete.deleted, true);
assert.equal(confirmedDelete.already_absent, false);

const duplicateDeleteService = loadTsModule('worker/src/services/tencent-eks-ci-service.ts', {
  './provider-errors': providerErrors,
}, {
  fetch: async () => jsonResponse({ Response: { Error: { Code: 'ResourceNotFound.EksCi', Message: 'already gone' }, RequestId: 'req-absent' } }),
});
assert.equal((await duplicateDeleteService.deleteTencentEksContainerInstances(tencentLiveEnv, ['eksci-absent'])).already_absent, true);

const reconcileActions = [];
const reconcilingTencentService = loadTsModule('worker/src/services/tencent-eks-ci-service.ts', {
  './provider-errors': providerErrors,
}, {
  fetch: async (_url, init) => {
    const action = new Headers(init.headers).get('X-TC-Action');
    reconcileActions.push(action);
    if (action === 'CreateEKSContainerInstances') throw new DOMException('fixture timeout', 'AbortError');
    if (action === 'DescribeEKSContainerInstances') {
      return jsonResponse({ Response: { RequestId: 'req-reconcile', TotalCount: 1, EksCis: [{ EksCiId: 'eksci-reconciled', EksCiName: 'scan-agent-run-fixture' }] } });
    }
    throw new Error(`unexpected Tencent action ${action}`);
  },
});
const reconciledLaunch = await reconcilingTencentService.launchTencentEksContainerInstance(tencentLiveEnv, tencentInput);
assert.deepEqual(reconcileActions, ['CreateEKSContainerInstances', 'DescribeEKSContainerInstances']);
assert.equal(reconciledLaunch.provider_job_id, 'eksci-reconciled');
const tencentServiceSource = readFileSync(resolve(root, 'worker/src/services/tencent-eks-ci-service.ts'), 'utf8');
assert.match(tencentServiceSource, /delete accepted but absence is not yet confirmed/, 'cleanup must not complete before Describe confirms absence');
assert.throws(() => tencentService.buildCreateEksContainerInstancesRequest({ ...tencentEnv, TENCENT_EKS_CI_IMAGE: 'ccr.ccs.tencentyun.com/scan-agent/scan-agent:latest' }, tencentInput), /immutable sha256 digest/);
assert.throws(() => tencentService.buildCreateEksContainerInstancesRequest({ ...tencentEnv, TENCENT_TCR_SERVER: 'ccr.ccs.tencentyun.com' }, tencentInput), /configured together/);
const signedTencent = await tencentService.buildTencentTc3Request('DescribeEKSContainerInstances', { Limit: 1, Offset: 0 }, 'ap-shanghai', 'AKIDEXAMPLE', 'SECRETKEYEXAMPLE', 1700000000);
assert.equal(signedTencent.body, '{"Limit":1,"Offset":0}');
assert.equal(signedTencent.headers.Authorization, 'TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2023-11-14/tke/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=e8a6d7c1f590277205e413c34aa3ff8955bfae2ceab10f02c14e394ea18b791e');
assert.deepEqual(JSON.parse(JSON.stringify(agentProvider.resolveProviderLaunchPlan(tencentEnv, tencentInput.task).candidates)), ['tencent_eks_ci']);
const autoCandidates = agentProvider.resolveProviderLaunchPlan(baseEnv, tencentInput.task).candidates;
assert.equal(autoCandidates.includes('tencent_eks_ci'), false);

const cnPreflight = await providerPreflight.buildProviderPreflight(baseEnv, { targets: ['example.cn'], target_urls: ['http://api.example.cn:8000/'], modules: ['subdomain'], provider: 'auto' });
assert.equal(cnPreflight.candidates[0], 'aliyun_eci');
assert.equal(cnPreflight.config.ok, true);
assert.equal(cnPreflight.dry_run_payloads[0].payload_summary.target_url_count, 1);
assert.doesNotMatch(JSON.stringify(cnPreflight), /agent-token-redacted|CALLBACK_TOKEN=[^\"]+/);
assert.match(JSON.stringify(cnPreflight), /\[redacted\]/);
const tencentPreflight = await providerPreflight.buildProviderPreflight(tencentEnv, { targets: ['example.cn'], modules: ['http_probe'], provider: 'tencent_eks_ci' });
assert.equal(tencentPreflight.provider, 'tencent_eks_ci');
assert.deepEqual(JSON.parse(JSON.stringify(tencentPreflight.candidates)), ['tencent_eks_ci']);
assert.equal(tencentPreflight.config.ok, true);
assert.equal(tencentPreflight.dry_run_payloads[0].dry_run_enabled, true);
assert.equal(tencentPreflight.dry_run_payloads[0].provider_config_summary.image_digest_pinned, true);
assert.equal(tencentPreflight.dry_run_payloads[0].provider_config_summary.restart_policy, 'Never');
assert.equal(tencentPreflight.dry_run_payloads[0].required_config.missing.length, 0);
assert.equal(tencentPreflight.cloud_check.attempted, false);
const disabledCloudCheck = await providerPreflight.buildProviderPreflight(tencentEnv, { targets: ['example.cn'], modules: ['http_probe'], provider: 'tencent_eks_ci', cloud_check: true });
assert.equal(disabledCloudCheck.cloud_check.attempted, false);
assert.match(disabledCloudCheck.cloud_check.reason, /disabled/);
assert.match(JSON.stringify(tencentPreflight), /\[redacted\]/);
assert.doesNotMatch(JSON.stringify(tencentPreflight), /short-callback-token|SECRETKEYEXAMPLE/);
const lowCostPreflight = await providerPreflight.buildProviderPreflight({ ...baseEnv, AGENT_AUTO_ROUTING_POLICY: 'lowest_cost' }, { targets: ['example.com'], provider: 'auto' });
assert.equal(lowCostPreflight.candidates[0], 'aliyun_eci');
const missingPreflight = await providerPreflight.buildProviderPreflight({ AGENT_PROVIDER: 'gcp_cloud_run', CLOUD_RUN_DRY_RUN: 'true' }, { targets: ['example.com'], provider: 'gcp_cloud_run' });
assert.equal(missingPreflight.config.ok, false);
assert.ok(missingPreflight.config.errors.some((issue) => issue.code === 'provider_config_missing'));

const nonRetrySummary = consumer.summarizeLaunchFailures([missingConfig], 'fallback');
assert.equal(nonRetrySummary.retryable, false);
assert.match(nonRetrySummary.reason, /GCP_PROJECT_ID/);
const retrySummary = consumer.summarizeLaunchFailures([missingConfig, cloud503], 'fallback');
assert.equal(retrySummary.retryable, true);
assert.equal(retrySummary.errors.length, 2);

const cleanupWrites = [];
const cleanupEnv = {
  DB: {
    prepare: (sql) => ({
      bind: (...values) => ({
        run: async () => { cleanupWrites.push({ sql, values }); return { success: true }; },
      }),
    }),
  },
};
cleanupMode = 'success';
const cleanupSuccess = await cleanupService.cleanupProviderRun(cleanupEnv, { id: 'run_cleanup', task_id: 'task_cleanup', provider: 'tencent_eks_ci', provider_job_id: 'eksci-fixture', provider_cleanup_attempts: 0 });
assert.equal(cleanupSuccess.completed, true);
assert.ok(cleanupWrites.some((write) => write.sql.includes('provider_cleanup_completed_at')));
cleanupMode = 'failure';
const cleanupFailure = await cleanupService.cleanupProviderRun(cleanupEnv, { id: 'run_cleanup_fail', task_id: 'task_cleanup', provider: 'tencent_eks_ci', provider_job_id: 'eksci-failure', provider_cleanup_attempts: 0 });
assert.equal(cleanupFailure.completed, false);
assert.match(cleanupFailure.error, /cleanup timeout/);
assert.ok(cleanupWrites.some((write) => write.sql.includes('provider_cleanup_attempts')));
const dryCleanup = await cleanupService.cleanupProviderRun(cleanupEnv, { id: 'run_dry', task_id: 'task_cleanup', provider: 'tencent_eks_ci', provider_job_id: 'dry-run:tencent-eks-ci/test', provider_cleanup_attempts: 0 });
assert.equal(dryCleanup.attempted, false);
assert.equal(dryCleanup.completed, true);

console.log(JSON.stringify({
  ok: true,
  classification_matrix: [
    providerErrors.serializeProviderError(missingConfig),
    providerErrors.serializeProviderError(cloud503),
    providerErrors.serializeProviderError(cloud401),
    providerErrors.serializeProviderError(aliyunThrottle),
    providerErrors.serializeProviderError(aliyunInvalid),
    providerErrors.serializeProviderError(tencentAuth),
    providerErrors.serializeProviderError(tencentThrottle),
    providerErrors.serializeProviderError(tencentInvalid),
    providerErrors.serializeProviderError(tencentQuota),
    providerErrors.serializeProviderError(tencentTransient),
  ],
  preflight_examples: {
    cn_region_first_candidate: cnPreflight.candidates[0],
    lowest_cost_first_candidate: lowCostPreflight.candidates[0],
    missing_config_codes: missingPreflight.config.errors.map((issue) => `${issue.code}:${issue.field}`),
    dry_run_payload_count: cnPreflight.dry_run_payloads.length,
    target_url_count: cnPreflight.dry_run_payloads[0].payload_summary.target_url_count,
    redacted_payload_marker_present: JSON.stringify(cnPreflight).includes('[redacted]'),
    tencent_explicit_candidate: tencentPreflight.candidates[0],
    tencent_dry_run: tencentPreflight.dry_run_payloads[0].dry_run_enabled,
    tencent_auto_excluded: !autoCandidates.includes('tencent_eks_ci'),
  },
  queue_decisions: {
    non_retryable_config: { retryable: nonRetrySummary.retryable, reason: nonRetrySummary.reason },
    transient_mixed: { retryable: retrySummary.retryable, errors: retrySummary.errors.map((err) => ({ category: err.category, retryable: err.retryable })) },
  },
  tencent_api_fixtures: {
    delete_then_describe_absence: confirmedDelete.deleted,
    duplicate_delete_is_idempotent: true,
    create_timeout_reconciled_by_name: reconciledLaunch.provider_job_id,
    cleanup_failure_recorded_for_retry: cleanupFailure.completed === false,
  },
  network: 'not used',
  cloud_credentials: 'not used',
}, null, 2));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function loadTsModule(relativePath, requireMap = {}, globalOverrides = {}) {
  const filePath = resolve(root, relativePath);
  const source = readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    exports: module.exports,
    module,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`verify-p1-provider cannot load ${specifier} from ${relativePath}`);
    },
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    crypto,
    TextEncoder,
    Date,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    btoa,
    atob,
    fetch: async () => { throw new Error('network disabled in verifier'); },
    ...globalOverrides,
  };
  vm.runInNewContext(compiled, sandbox, { filename: filePath });
  return module.exports;
}
