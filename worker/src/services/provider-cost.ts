import type { Env } from '../env';
import type { ExternalAgentProvider } from './agent-provider';

export interface ProviderCostEstimate {
  provider: ExternalAgentProvider;
  estimated_cost_usd: number;
  duration_seconds: number;
  cpu: number;
  memory_gib: number;
  region_hint: string;
  within_budget: boolean;
}

export interface AutoProviderDecision {
  provider: ExternalAgentProvider;
  candidates: ExternalAgentProvider[];
  policy: 'region' | 'lowest_cost';
  fallback_enabled: boolean;
  region_hint: string;
  reason: string;
  max_cost_usd: number | null;
  estimates: ProviderCostEstimate[];
}

export interface TaskForRouting {
  targets_json: string;
  max_cost_usd?: number | null;
}

const DEFAULT_DURATION_SECONDS = 600;
const DEFAULT_CPU = 1;
const DEFAULT_MEMORY_GIB = 0.5;
const DEFAULT_GCP_VCPU_SECOND = 0.000018;
const DEFAULT_GCP_MEMORY_GIB_SECOND = 0.000002;
const DEFAULT_ALIYUN_VCPU_SECOND = 0.0000077;
const DEFAULT_ALIYUN_MEMORY_GIB_SECOND = 0.00000096;

export function resolveAutoAgentProvider(env: Env, task: TaskForRouting): AutoProviderDecision {
  const policy = env.AGENT_AUTO_ROUTING_POLICY === 'lowest_cost' ? 'lowest_cost' : 'region';
  const fallbackEnabled = env.AGENT_AUTO_ENABLE_FALLBACK !== 'false';
  const regionHint = inferTargetRegion(task.targets_json);
  const maxCostUsd = resolveMaxCostUsd(env, task);
  const estimates = estimateProviderCosts(env, regionHint, maxCostUsd);
  const byProvider = new Map(estimates.map((estimate) => [estimate.provider, estimate]));

  const preferred = policy === 'lowest_cost'
    ? [...estimates].sort(byCost)[0].provider
    : regionHint === 'cn'
      ? normalizeProvider(env.AGENT_AUTO_CN_PROVIDER, 'aliyun_eci')
      : normalizeProvider(env.AGENT_AUTO_DEFAULT_PROVIDER, 'gcp_cloud_run');
  const ordered = policy === 'lowest_cost'
    ? [...estimates].sort(byCost).map((estimate) => estimate.provider)
    : [preferred, ...[...estimates].sort(byCost).map((estimate) => estimate.provider).filter((provider) => provider !== preferred)];
  const withinBudget = ordered.filter((provider) => byProvider.get(provider)?.within_budget ?? true);
  const candidates = fallbackEnabled ? withinBudget : withinBudget.slice(0, 1);
  const provider = candidates[0] ?? preferred;
  const preferredEstimate = byProvider.get(preferred);

  return {
    provider,
    candidates,
    policy,
    fallback_enabled: fallbackEnabled,
    region_hint: regionHint,
    max_cost_usd: maxCostUsd,
    reason: buildReason(policy, regionHint, provider, preferredEstimate, maxCostUsd, candidates.length),
    estimates,
  };
}

export function estimateProviderCosts(env: Env, regionHint = 'global', maxCostUsd: number | null = resolveMaxCostUsd(env, {})): ProviderCostEstimate[] {
  const duration = parsePositiveNumber(env.AGENT_ESTIMATED_DURATION_SECONDS, DEFAULT_DURATION_SECONDS);
  const cpu = parsePositiveNumber(env.AGENT_CPU, DEFAULT_CPU);
  const memory = parsePositiveNumber(env.AGENT_MEMORY_GIB, DEFAULT_MEMORY_GIB);
  return [
    estimate('gcp_cloud_run', duration, cpu, memory, regionHint, maxCostUsd, parsePositiveNumber(env.GCP_CLOUD_RUN_VCPU_SECOND_PRICE, DEFAULT_GCP_VCPU_SECOND), parsePositiveNumber(env.GCP_CLOUD_RUN_MEMORY_GIB_SECOND_PRICE, DEFAULT_GCP_MEMORY_GIB_SECOND)),
    estimate('aliyun_eci', duration, cpu, memory, regionHint, maxCostUsd, parsePositiveNumber(env.ALIYUN_ECI_VCPU_SECOND_PRICE, DEFAULT_ALIYUN_VCPU_SECOND), parsePositiveNumber(env.ALIYUN_ECI_MEMORY_GIB_SECOND_PRICE, DEFAULT_ALIYUN_MEMORY_GIB_SECOND)),
  ];
}

function estimate(provider: ExternalAgentProvider, duration: number, cpu: number, memory: number, regionHint: string, maxCostUsd: number | null, vcpuSecondPrice: number, memoryGibSecondPrice: number): ProviderCostEstimate {
  const estimatedCost = duration * ((cpu * vcpuSecondPrice) + (memory * memoryGibSecondPrice));
  return {
    provider,
    estimated_cost_usd: estimatedCost,
    duration_seconds: duration,
    cpu,
    memory_gib: memory,
    region_hint: regionHint,
    within_budget: maxCostUsd === null || estimatedCost <= maxCostUsd,
  };
}

function inferTargetRegion(targetsJson: string): string {
  try {
    const targets = JSON.parse(targetsJson) as string[];
    return targets.some((target) => isChinaTarget(String(target))) ? 'cn' : 'global';
  } catch {
    return 'global';
  }
}

function isChinaTarget(target: string): boolean {
  const host = target.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  return host === 'cn' || host.endsWith('.cn') || host.endsWith('.中国') || host.endsWith('.公司') || host.endsWith('.网络');
}

function normalizeProvider(value: string | undefined, fallback: ExternalAgentProvider): ExternalAgentProvider {
  return value === 'gcp_cloud_run' || value === 'aliyun_eci' ? value : fallback;
}

function resolveMaxCostUsd(env: Env, task: Pick<TaskForRouting, 'max_cost_usd'>): number | null {
  if (typeof task.max_cost_usd === 'number' && Number.isFinite(task.max_cost_usd) && task.max_cost_usd > 0) return task.max_cost_usd;
  const parsed = Number(env.AGENT_MAX_COST_USD);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function byCost(a: ProviderCostEstimate, b: ProviderCostEstimate): number {
  return a.estimated_cost_usd - b.estimated_cost_usd;
}

function buildReason(policy: 'region' | 'lowest_cost', regionHint: string, provider: ExternalAgentProvider, preferredEstimate: ProviderCostEstimate | undefined, maxCostUsd: number | null, candidateCount: number): string {
  const cost = preferredEstimate ? ` ~= $${preferredEstimate.estimated_cost_usd.toFixed(6)}` : '';
  const budget = maxCostUsd === null ? '' : `, max_cost_usd=$${maxCostUsd}`;
  if (candidateCount === 0) return `no provider estimate is within budget${budget}`;
  if (policy === 'lowest_cost') return `lowest estimated cost selected ${provider}${cost}${budget}`;
  return regionHint === 'cn' ? `region policy selected CN provider ${provider}${cost}${budget}` : `region policy selected default provider ${provider}${cost}${budget}`;
}
