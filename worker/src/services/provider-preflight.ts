import type { Env } from '../env';
import type { AgentProviderTaskContext } from './agent-provider';
import { resolveProviderLaunchPlan, type ExternalAgentProvider } from './agent-provider';
import { isTruthy, validateRuntimeConfig } from './config-validation';
import { describeTencentEksContainerInstances, isTencentEksCiDryRun } from './tencent-eks-ci-service';
import { serializeProviderError, toProviderLaunchError } from './provider-errors';

export interface ProviderPreflightInput {
  provider?: Env['AGENT_PROVIDER'];
  targets?: string[];
  target_urls?: string[];
  modules?: string[];
  rate_limit?: number;
  timeout_minutes?: number;
  max_cost_usd?: number | null;
  cloud_check?: boolean;
}

export async function buildProviderPreflight(env: Env, input: ProviderPreflightInput = {}): Promise<unknown> {
  const effectiveEnv: Env = { ...env, AGENT_PROVIDER: input.provider ?? env.AGENT_PROVIDER };
  const task: AgentProviderTaskContext = {
    id: 'preflight-task',
    targets_json: JSON.stringify(input.targets?.length ? input.targets : ['example.com']),
    modules_json: JSON.stringify(input.modules?.length ? input.modules : ['subdomain', 'http_probe']),
    rate_limit: input.rate_limit ?? 50,
    timeout_minutes: input.timeout_minutes ?? 30,
    max_cost_usd: input.max_cost_usd ?? null,
  };
  const plan = resolveProviderLaunchPlan(effectiveEnv, task);
  const config = validateRuntimeConfig(effectiveEnv);
  const cloudCheck = await buildReadOnlyCloudCheck(effectiveEnv, input, plan.candidates);
  return {
    provider: plan.provider,
    candidates: plan.candidates,
    auto_decision: plan.auto_decision ?? null,
    config,
    cloud_check: cloudCheck,
    dry_run_payloads: plan.candidates.map((candidate) => ({
      provider: candidate,
      dry_run_enabled: providerDryRunEnabled(effectiveEnv, candidate),
      required_config: requiredConfigSummary(effectiveEnv, candidate),
      provider_config_summary: providerConfigSummary(effectiveEnv, candidate),
      payload_summary: {
        task_id: task.id,
        target_count: JSON.parse(task.targets_json).length,
        target_url_count: input.target_urls?.length ?? 0,
        modules: JSON.parse(task.modules_json),
        rate_limit: task.rate_limit,
        timeout_minutes: task.timeout_minutes,
        scan_mode: effectiveEnv.AGENT_SCAN_MODE ?? 'mock',
        callback_base_url_present: Boolean(effectiveEnv.CALLBACK_BASE_URL),
        callback_token: '[redacted]',
      },
    })),
  };
}

async function buildReadOnlyCloudCheck(env: Env, input: ProviderPreflightInput, candidates: ExternalAgentProvider[]): Promise<Record<string, unknown>> {
  const requested = input.cloud_check === true;
  const enabled = isTruthy(env.TENCENT_EKS_CI_READONLY_PREFLIGHT_ENABLED);
  if (!requested) return { requested: false, enabled, attempted: false };
  if (!candidates.includes('tencent_eks_ci')) return { requested: true, enabled, attempted: false, reason: 'tencent_eks_ci is not a preflight candidate' };
  if (!enabled) return { requested: true, enabled: false, attempted: false, reason: 'read-only Tencent cloud preflight is disabled' };
  try {
    const result = await describeTencentEksContainerInstances(env, { limit: 1 });
    return {
      requested: true,
      enabled: true,
      attempted: true,
      ok: true,
      request_id: result.request_id,
      total_count: result.total_count,
      checks: ['endpoint_reachable', 'tc3_signature_accepted', 'describe_permission_accepted'],
      limitations: ['create_permission_not_checked', 'image_pull_not_checked', 'subnet_capacity_not_checked', 'runtime_egress_not_checked'],
    };
  } catch (error) {
    const providerError = toProviderLaunchError(error, 'tencent_eks_ci');
    return {
      requested: true,
      enabled: true,
      attempted: true,
      ok: false,
      error: serializeProviderError(providerError),
    };
  }
}

function requiredConfigSummary(env: Env, provider: ExternalAgentProvider): { present: string[]; missing: string[] } {
  const fields = provider === 'gcp_cloud_run'
    ? ['CALLBACK_BASE_URL', 'GCP_PROJECT_ID', 'GCP_LOCATION', 'CLOUD_RUN_JOB_NAME']
    : provider === 'aliyun_eci'
      ? ['CALLBACK_BASE_URL', 'ALIYUN_REGION_ID', 'ALIYUN_SECURITY_GROUP_ID', 'ALIYUN_VSWITCH_ID', 'ALIYUN_ECI_IMAGE']
      : ['CALLBACK_BASE_URL', 'TENCENT_EKS_CI_REGION', 'TENCENT_EKS_CI_VPC_ID', 'TENCENT_EKS_CI_SUBNET_ID', 'TENCENT_EKS_CI_SECURITY_GROUP_IDS', 'TENCENT_EKS_CI_IMAGE'];
  return {
    present: fields.filter((field) => Boolean((env as unknown as Record<string, string | undefined>)[field])),
    missing: fields.filter((field) => !((env as unknown as Record<string, string | undefined>)[field])),
  };
}

function providerDryRunEnabled(env: Env, provider: ExternalAgentProvider): boolean {
  if (provider === 'gcp_cloud_run') return isTruthy(env.CLOUD_RUN_DRY_RUN);
  if (provider === 'aliyun_eci') return isTruthy(env.ALIYUN_ECI_DRY_RUN);
  return isTencentEksCiDryRun(env.TENCENT_EKS_CI_DRY_RUN);
}

function providerConfigSummary(env: Env, provider: ExternalAgentProvider): Record<string, unknown> {
  if (provider !== 'tencent_eks_ci') return {};
  const image = env.TENCENT_EKS_CI_IMAGE ?? '';
  const registryHost = image.includes('/') ? image.split('/')[0] : null;
  const securityGroupCount = (env.TENCENT_EKS_CI_SECURITY_GROUP_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean).length;
  return {
    region_present: Boolean(env.TENCENT_EKS_CI_REGION),
    vpc_id_present: Boolean(env.TENCENT_EKS_CI_VPC_ID),
    subnet_id_present: Boolean(env.TENCENT_EKS_CI_SUBNET_ID),
    security_group_count: securityGroupCount,
    registry_host: registryHost,
    image_digest_pinned: /@sha256:[a-f0-9]{64}$/.test(image),
    replicas: 1,
    restart_policy: 'Never',
    readonly_cloud_check_enabled: isTruthy(env.TENCENT_EKS_CI_READONLY_PREFLIGHT_ENABLED),
    credentials: '[redacted]',
  };
}
