import type { Env } from '../env';
import { launchAliyunEciContainer } from './aliyun-eci-service';
import { launchCloudRunJob } from './cloud-run-service';
import { launchTencentEksContainerInstance, deleteTencentEksContainerInstances } from './tencent-eks-ci-service';
import { type AutoProviderDecision, resolveAutoAgentProvider } from './provider-cost';

export type EffectiveAgentProvider = 'mock_inline' | 'manual' | 'gcp_cloud_run' | 'aliyun_eci' | 'tencent_eks_ci';
export type ExternalAgentProvider = 'gcp_cloud_run' | 'aliyun_eci' | 'tencent_eks_ci';
export type AutoRoutableAgentProvider = 'gcp_cloud_run' | 'aliyun_eci';

export interface AgentProviderTaskContext {
  id: string;
  targets_json: string;
  modules_json: string;
  rate_limit: number;
  timeout_minutes: number;
  max_cost_usd?: number | null;
}

export interface LaunchAgentProviderInput {
  task: AgentProviderTaskContext;
  shard_id: string;
  agent_run_id: string;
  callback_token: string;
}

export interface AgentProviderLaunchResult {
  provider_job_id: string;
  region: string;
  image: string;
  dry_run: boolean;
}

export interface InitialProviderRunMetadata {
  provider: string;
  provider_job_id: string | null;
  image: string;
  region: string | null;
}

export interface ProviderLaunchPlan {
  provider: EffectiveAgentProvider;
  candidates: ExternalAgentProvider[];
  auto_decision?: AutoProviderDecision;
}

export function resolveEffectiveAgentProvider(env: Env, task?: Pick<AgentProviderTaskContext, 'targets_json' | 'max_cost_usd'>): EffectiveAgentProvider {
  return resolveProviderLaunchPlan(env, task).provider;
}

export function resolveProviderLaunchPlan(env: Env, task?: Pick<AgentProviderTaskContext, 'targets_json' | 'max_cost_usd'>): ProviderLaunchPlan {
  if (env.AGENT_PROVIDER === 'gcp_cloud_run') return { provider: 'gcp_cloud_run', candidates: ['gcp_cloud_run'] };
  if (env.AGENT_PROVIDER === 'aliyun_eci') return { provider: 'aliyun_eci', candidates: ['aliyun_eci'] };
  if (env.AGENT_PROVIDER === 'tencent_eks_ci') return { provider: 'tencent_eks_ci', candidates: ['tencent_eks_ci'] };
  if (env.AGENT_PROVIDER === 'auto') {
    if (!task) {
      const provider = normalizeAutoDefaultProvider(env);
      return { provider, candidates: [provider] };
    }
    const decision = resolveAutoAgentProvider(env, task);
    return { provider: decision.provider, candidates: decision.candidates, auto_decision: decision };
  }
  if (env.AGENT_PROVIDER === 'manual') return { provider: 'manual', candidates: [] };
  if (env.AGENT_PROVIDER === 'mock') return env.MOCK_AGENT_MODE === 'manual' ? { provider: 'manual', candidates: [] } : { provider: 'mock_inline', candidates: [] };
  return env.MOCK_AGENT_MODE === 'inline' ? { provider: 'mock_inline', candidates: [] } : { provider: 'manual', candidates: [] };
}

export function isExternalAgentProvider(provider: EffectiveAgentProvider): provider is ExternalAgentProvider {
  return provider === 'gcp_cloud_run' || provider === 'aliyun_eci' || provider === 'tencent_eks_ci';
}

export function initialProviderRunMetadata(env: Env, provider: EffectiveAgentProvider): InitialProviderRunMetadata {
  switch (provider) {
    case 'mock_inline':
      return { provider: 'mock', provider_job_id: 'mock-execution', image: 'mock-agent:v0', region: 'local' };
    case 'manual':
      return { provider: 'manual', provider_job_id: null, image: 'external-agent:manual', region: 'local' };
    case 'gcp_cloud_run':
      return {
        provider: 'gcp_cloud_run',
        provider_job_id: null,
        image: `cloud-run-job:${env.CLOUD_RUN_JOB_NAME ?? 'unset'}`,
        region: env.GCP_LOCATION ?? null,
      };
    case 'aliyun_eci':
      return {
        provider: 'aliyun_eci',
        provider_job_id: null,
        image: env.ALIYUN_ECI_IMAGE ?? 'aliyun-eci-image:unset',
        region: env.ALIYUN_REGION_ID ?? null,
      };
    case 'tencent_eks_ci':
      return {
        provider: 'tencent_eks_ci',
        provider_job_id: null,
        image: env.TENCENT_EKS_CI_IMAGE ?? 'tencent-eks-ci-image:unset',
        region: env.TENCENT_EKS_CI_REGION ?? null,
      };
  }
}

export async function launchAgentProvider(env: Env, provider: ExternalAgentProvider, input: LaunchAgentProviderInput): Promise<AgentProviderLaunchResult> {
  switch (provider) {
    case 'gcp_cloud_run':
      return launchCloudRunJob(env, input);
    case 'aliyun_eci':
      return launchAliyunEciContainer(env, input);
    case 'tencent_eks_ci':
      return launchTencentEksContainerInstance(env, input);
  }
}

export async function deleteAgentProviderJob(env: Env, provider: ExternalAgentProvider, providerJobId: string): Promise<{ deleted: boolean; already_absent: boolean }> {
  if (provider !== 'tencent_eks_ci') return { deleted: true, already_absent: true };
  const result = await deleteTencentEksContainerInstances(env, [providerJobId]);
  return { deleted: result.deleted, already_absent: result.already_absent };
}

function normalizeAutoDefaultProvider(env: Env): AutoRoutableAgentProvider {
  return env.AGENT_AUTO_DEFAULT_PROVIDER === 'aliyun_eci' ? 'aliyun_eci' : 'gcp_cloud_run';
}
