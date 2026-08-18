import type { Env } from '../env';
import type { AgentProviderLaunchResult, LaunchAgentProviderInput } from './agent-provider';
import { ProviderLaunchError, classifyProviderHttpError, classifyTencentProviderCode, providerConfigMissing } from './provider-errors';
import { normalizePublicIpv4 } from './provider-egress-service';
import { buildTencentTc3ServiceRequest, type TencentSignedRequest } from './tencent-tc3-service';

const TENCENT_TKE_ENDPOINT = 'https://tke.tencentcloudapi.com/';
const TENCENT_TKE_HOST = 'tke.tencentcloudapi.com';
const TENCENT_TKE_SERVICE = 'tke';
const TENCENT_TKE_VERSION = '2018-05-25';
const DEFAULT_API_TIMEOUT_MS = 10_000;
const MAX_API_TIMEOUT_MS = 30_000;
const DELETE_CONFIRM_ATTEMPTS = 4;
const DELETE_CONFIRM_DELAY_MS = 5_000;
const DELETE_CONFIRM_REQUIRED_CONSECUTIVE_ABSENCE = 2;

interface TencentEnvironmentVariable {
  Name: string;
  Value: string;
}

interface TencentContainer {
  Name: string;
  Image: string;
  EnvironmentVars: TencentEnvironmentVariable[];
  CurrentState?: TencentContainerState;
}

export interface TencentContainerState {
  State?: string;
  Reason?: string;
  Message?: string;
  ExitCode?: number;
}

interface TencentImageRegistryCredential {
  Server: string;
  Username: string;
  Password: string;
  Name: string;
}

export interface TencentCreateEksCiRequest {
  Containers: TencentContainer[];
  EksCiName: string;
  SecurityGroupIds: string[];
  SubnetId: string;
  VpcId: string;
  Memory: number;
  Cpu: number;
  Replicas: 1;
  RestartPolicy: 'Never';
  AutoCreateEip?: boolean;
  AutoCreateEipAttribute?: {
    DeletePolicy: 'Release';
    InternetServiceProvider: 'BGP' | 'CMCC' | 'CTCC' | 'CUCC';
    InternetMaxBandwidthOut: number;
  };
  ImageRegistryCredentials?: TencentImageRegistryCredential[];
}

export interface TencentEksCi {
  AutoCreatedEipId?: string;
  EipAddress?: string;
  EksCiId?: string;
  EksCiName?: string;
  Status?: string;
  Containers?: TencentContainer[];
}

export interface TencentEksCiEvent {
  PodName?: string;
  Reason?: string;
  Type?: string;
  Count?: number;
  FirstTimestamp?: string;
  LastTimestamp?: string;
  Message?: string;
}

interface TencentResponseBody {
  Response?: {
    Error?: {
      Code?: string;
      Message?: string;
    };
    RequestId?: string;
    EksCiIds?: string[];
    EksCis?: TencentEksCi[];
    Events?: TencentEksCiEvent[];
    TotalCount?: number;
  };
}

export interface TencentEksCiDeleteResult {
  deleted: boolean;
  already_absent: boolean;
  request_id: string | null;
}

export interface TencentEksCiDeleteOptions {
  confirmation_attempts?: number;
  confirmation_delay_ms?: number;
  required_consecutive_absence?: number;
}

export async function launchTencentEksContainerInstance(env: Env, input: LaunchAgentProviderInput): Promise<AgentProviderLaunchResult> {
  const config = resolveTencentConfig(env);
  const eksCiName = buildTencentEksCiName(input.agent_run_id);
  const payload = buildCreateEksContainerInstancesRequest(env, input, config.callbackBaseUrl, eksCiName);

  if (isTencentEksCiDryRun(env.TENCENT_EKS_CI_DRY_RUN)) {
    return {
      provider_job_id: `dry-run:tencent-eks-ci/${config.region}/${eksCiName}/${input.agent_run_id}`,
      region: config.region,
      image: config.image,
      dry_run: true,
    };
  }

  const secretId = required(env.TENCENT_SECRET_ID, 'TENCENT_SECRET_ID');
  const secretKey = required(env.TENCENT_SECRET_KEY, 'TENCENT_SECRET_KEY');
  try {
    const response = await callTencentTkeApi(env, 'CreateEKSContainerInstances', payload, config.region, secretId, secretKey);
    const ids = response.Response?.EksCiIds ?? [];
    if (ids.length !== 1 || !ids[0]) {
      throw new ProviderLaunchError({
        provider: 'tencent_eks_ci',
        phase: 'parse',
        category: 'unknown',
        retryable: false,
        safe_message: `tencent_eks_ci create returned ${ids.length} container instance identifiers; expected exactly one`,
      });
    }
    const instance = await describeTencentEksContainerInstances(env, { ids: [ids[0]], limit: 1 })
      .then((result) => result.instances.find((candidate) => candidate.EksCiId === ids[0]) ?? null)
      .catch(() => null);
    return launchResult(ids[0], config.region, config.image, instance);
  } catch (error) {
    const shouldReconcile = !(error instanceof ProviderLaunchError) || (error.phase === 'request' && error.retryable);
    if (!shouldReconcile && error instanceof ProviderLaunchError) throw error;
    const reconciled = await reconcileTencentEksCiByName(env, eksCiName).catch(() => null);
    if (reconciled?.EksCiId) {
      return launchResult(reconciled.EksCiId, config.region, config.image, reconciled);
    }
    if (error instanceof ProviderLaunchError) throw error;
    throw new ProviderLaunchError({
      provider: 'tencent_eks_ci',
      phase: 'request',
      category: 'transient',
      retryable: true,
      safe_message: `tencent_eks_ci create outcome is unknown after transport failure: ${safeErrorMessage(error)}`,
    });
  }
}

export function buildCreateEksContainerInstancesRequest(
  env: Env,
  input: LaunchAgentProviderInput,
  callbackBaseUrl = trimTrailingSlash(required(env.CALLBACK_BASE_URL, 'CALLBACK_BASE_URL')),
  eksCiName = buildTencentEksCiName(input.agent_run_id),
): TencentCreateEksCiRequest {
  const image = validateDigestImage(required(env.TENCENT_EKS_CI_IMAGE, 'TENCENT_EKS_CI_IMAGE'), env.TENCENT_EKS_CI_ALLOWED_REGISTRY_HOST);
  const environmentVars: TencentEnvironmentVariable[] = [
    ['TASK_ID', input.task.id],
    ['SHARD_ID', input.shard_id],
    ['AGENT_RUN_ID', input.agent_run_id],
    ['CALLBACK_BASE_URL', callbackBaseUrl],
    ['CALLBACK_TOKEN', input.callback_token],
    ['CONFIG_URL', `${callbackBaseUrl}/api/agent/config`],
    ['TARGETS_URL', `${callbackBaseUrl}/api/agent/targets`],
    ['CANDIDATES_URL', `${callbackBaseUrl}/api/agent/candidates`],
    ['MODULES', parseModulesForEnv(input.task.modules_json).join(',')],
    ['RATE_LIMIT', String(input.task.rate_limit)],
    ['TIMEOUT_MINUTES', String(input.task.timeout_minutes)],
    ['AGENT_HEARTBEAT_INTERVAL_SECONDS', env.AGENT_HEARTBEAT_INTERVAL_SECONDS ?? '30'],
    ['AGENT_MAX_CANDIDATES', env.AGENT_MAX_CANDIDATES ?? '500'],
    ['SCAN_MODE', env.AGENT_SCAN_MODE ?? 'mock'],
  ].map(([Name, Value]) => ({ Name, Value }));

  const request: TencentCreateEksCiRequest = {
    Containers: [{
      Name: validateContainerName(env.TENCENT_EKS_CI_CONTAINER_NAME ?? 'scan-agent'),
      Image: image,
      EnvironmentVars: environmentVars,
    }],
    EksCiName: eksCiName,
    SecurityGroupIds: parseSecurityGroupIds(required(env.TENCENT_EKS_CI_SECURITY_GROUP_IDS, 'TENCENT_EKS_CI_SECURITY_GROUP_IDS')),
    SubnetId: required(env.TENCENT_EKS_CI_SUBNET_ID, 'TENCENT_EKS_CI_SUBNET_ID'),
    VpcId: required(env.TENCENT_EKS_CI_VPC_ID, 'TENCENT_EKS_CI_VPC_ID'),
    Memory: parsePositiveNumber(env.TENCENT_EKS_CI_MEMORY, 2, 0.5, 256, 'TENCENT_EKS_CI_MEMORY'),
    Cpu: parsePositiveNumber(env.TENCENT_EKS_CI_CPU, 1, 0.25, 64, 'TENCENT_EKS_CI_CPU'),
    Replicas: 1,
    RestartPolicy: 'Never',
  };

  if (parseBoolean(env.TENCENT_EKS_CI_AUTO_CREATE_EIP, true)) {
    request.AutoCreateEip = true;
    request.AutoCreateEipAttribute = {
      DeletePolicy: 'Release',
      InternetServiceProvider: parseEipIsp(env.TENCENT_EKS_CI_EIP_ISP),
      InternetMaxBandwidthOut: parseInteger(env.TENCENT_EKS_CI_EIP_BANDWIDTH_MBPS, 5, 1, 100, 'TENCENT_EKS_CI_EIP_BANDWIDTH_MBPS'),
    };
  }

  const registryCredential = resolveRegistryCredential(env);
  if (registryCredential) request.ImageRegistryCredentials = [registryCredential];
  return request;
}

export async function describeTencentEksContainerInstances(
  env: Env,
  input: { ids?: string[]; name?: string; limit?: number } = {},
): Promise<{ request_id: string | null; total_count: number; instances: TencentEksCi[] }> {
  const region = required(env.TENCENT_EKS_CI_REGION, 'TENCENT_EKS_CI_REGION');
  const secretId = required(env.TENCENT_SECRET_ID, 'TENCENT_SECRET_ID');
  const secretKey = required(env.TENCENT_SECRET_KEY, 'TENCENT_SECRET_KEY');
  const ids = (input.ids ?? []).filter((id) => /^eksci-[A-Za-z0-9-]+$/.test(id)).slice(0, 20);
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const payload: Record<string, unknown> = { Limit: limit, Offset: 0 };
  if (ids.length) payload.EksCiIds = ids;
  if (input.name) payload.Filters = [{ Name: 'eks-ci-name', Values: [input.name] }];
  const response = await callTencentTkeApi(env, 'DescribeEKSContainerInstances', payload, region, secretId, secretKey);
  return {
    request_id: response.Response?.RequestId ?? null,
    total_count: response.Response?.TotalCount ?? 0,
    instances: response.Response?.EksCis ?? [],
  };
}

export async function describeTencentEksContainerInstanceEvents(
  env: Env,
  eksCiId: string,
  limit = 20,
): Promise<{ request_id: string | null; events: TencentEksCiEvent[] }> {
  if (!/^eksci-[A-Za-z0-9-]+$/.test(eksCiId)) throw configValidationError('EksCiId must be a valid eksci-* identifier');
  const region = required(env.TENCENT_EKS_CI_REGION, 'TENCENT_EKS_CI_REGION');
  const secretId = required(env.TENCENT_SECRET_ID, 'TENCENT_SECRET_ID');
  const secretKey = required(env.TENCENT_SECRET_KEY, 'TENCENT_SECRET_KEY');
  const response = await callTencentTkeApi(env, 'DescribeEKSContainerInstanceEvent', {
    EksCiId: eksCiId,
    Limit: Math.max(1, Math.min(100, Math.floor(limit))),
  }, region, secretId, secretKey);
  return {
    request_id: response.Response?.RequestId ?? null,
    events: response.Response?.Events ?? [],
  };
}

export async function deleteTencentEksContainerInstances(
  env: Env,
  ids: string[],
  options: TencentEksCiDeleteOptions = {},
): Promise<TencentEksCiDeleteResult> {
  const realIds = [...new Set(ids.filter((id) => /^eksci-[A-Za-z0-9-]+$/.test(id)))].slice(0, 20);
  if (!realIds.length) return { deleted: true, already_absent: true, request_id: null };
  const region = required(env.TENCENT_EKS_CI_REGION, 'TENCENT_EKS_CI_REGION');
  const secretId = required(env.TENCENT_SECRET_ID, 'TENCENT_SECRET_ID');
  const secretKey = required(env.TENCENT_SECRET_KEY, 'TENCENT_SECRET_KEY');
  let requestId: string | null = null;
  let alreadyAbsent = false;
  try {
    const response = await callTencentTkeApi(env, 'DeleteEKSContainerInstances', {
      EksCiIds: realIds,
      ReleaseAutoCreatedEip: true,
    }, region, secretId, secretKey);
    requestId = response.Response?.RequestId ?? null;
  } catch (error) {
    if (error instanceof ProviderLaunchError && /ContainerNotFound|ResourceNotFound/i.test(error.provider_code ?? '')) {
      alreadyAbsent = true;
    } else {
      throw error;
    }
  }

  await confirmTencentEksDeletion(env, realIds, requestId, options);
  return { deleted: true, already_absent: alreadyAbsent, request_id: requestId };
}

async function confirmTencentEksDeletion(
  env: Env,
  ids: string[],
  deleteRequestId: string | null,
  options: TencentEksCiDeleteOptions,
): Promise<void> {
  const attempts = boundedInteger(options.confirmation_attempts, DELETE_CONFIRM_ATTEMPTS, 2, 10);
  const delayMs = boundedInteger(options.confirmation_delay_ms, DELETE_CONFIRM_DELAY_MS, 0, 30_000);
  const requiredConsecutiveAbsence = boundedInteger(
    options.required_consecutive_absence,
    DELETE_CONFIRM_REQUIRED_CONSECUTIVE_ABSENCE,
    2,
    attempts,
  );
  let consecutiveAbsence = 0;
  let lastDescribeRequestId: string | null = null;
  let lastRemaining: string[] = [...ids];

  // Tencent deletion is asynchronous and Describe is eventually consistent.
  // Always observe the full stabilization window, even when the first read is
  // empty, so a temporarily invisible instance cannot be marked cleaned up.
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const confirmation = await describeTencentEksContainerInstances(env, { ids, limit: ids.length });
      lastDescribeRequestId = confirmation.request_id;
      const returnedIds = new Set(confirmation.instances.map((instance) => instance.EksCiId).filter((id): id is string => Boolean(id)));
      const exactRemaining = ids.filter((id) => returnedIds.has(id));
      // DescribeEKSContainerInstances may report a non-zero TotalCount for
      // the account even when an ID-filtered response contains no matching
      // instance. When confirming deletion of a specific container, the
      // authoritative signal is whether any requested ID is still returned;
      // relying on the aggregate count can leave cleanup pending forever.
      const absent = exactRemaining.length === 0;
      consecutiveAbsence = absent ? consecutiveAbsence + 1 : 0;
      lastRemaining = absent ? [] : exactRemaining.length ? exactRemaining : [...ids];
    } catch (error) {
      if (error instanceof ProviderLaunchError && /ContainerNotFound|ResourceNotFound/i.test(error.provider_code ?? '')) {
        consecutiveAbsence += 1;
        lastRemaining = [];
      } else {
        throw error;
      }
    }
    if (attempt + 1 < attempts) await delay(delayMs);
  }

  if (consecutiveAbsence >= requiredConsecutiveAbsence) return;
  throw new ProviderLaunchError({
    provider: 'tencent_eks_ci',
    phase: 'cleanup',
    category: 'pending',
    retryable: true,
    provider_code: 'DeletePropagationPending',
    safe_message: `tencent_eks_ci delete accepted but stable absence is not confirmed delete_request_id=${deleteRequestId ?? 'unknown'} describe_request_id=${lastDescribeRequestId ?? 'unknown'} remaining=${lastRemaining.join(',') || 'unknown'}`,
  });
}

export async function buildTencentTc3Request(
  action: string,
  payload: unknown,
  region: string,
  secretId: string,
  secretKey: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<TencentSignedRequest> {
  return buildTencentTc3ServiceRequest(action, payload, region, secretId, secretKey, {
    host: TENCENT_TKE_HOST,
    service: TENCENT_TKE_SERVICE,
    version: TENCENT_TKE_VERSION,
  }, timestamp);
}

export function isTencentEksCiDryRun(value: string | undefined): boolean {
  return !['0', 'false', 'no', 'off'].includes(String(value ?? '').toLowerCase());
}

export function isTencentEksCiAutoCreateEipEnabled(value: string | undefined): boolean {
  return !['0', 'false', 'no', 'off'].includes(String(value ?? '').toLowerCase());
}

export function buildTencentEksCiName(agentRunId: string): string {
  const suffix = agentRunId.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `scan-${suffix || 'agent-run'}`.slice(0, 49);
}

async function reconcileTencentEksCiByName(env: Env, name: string): Promise<TencentEksCi | null> {
  const result = await describeTencentEksContainerInstances(env, { name, limit: 2 });
  return result.instances.length === 1 ? result.instances[0] : null;
}

async function callTencentTkeApi(
  env: Env,
  action: string,
  payload: unknown,
  region: string,
  secretId: string,
  secretKey: string,
): Promise<TencentResponseBody> {
  const signed = await buildTencentTc3Request(action, payload, region, secretId, secretKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), parseApiTimeout(env.TENCENT_EKS_CI_API_TIMEOUT_MS));
  try {
    const response = await fetch(TENCENT_TKE_ENDPOINT, { method: 'POST', headers: signed.headers, body: signed.body, signal: controller.signal });
    const text = await response.text();
    let body: TencentResponseBody = {};
    try {
      body = text ? JSON.parse(text) as TencentResponseBody : {};
    } catch {
      throw classifyProviderHttpError('tencent_eks_ci', 'parse', response.status, 'Tencent TKE returned a malformed response');
    }
    const providerError = body.Response?.Error;
    if (providerError?.Code) {
      throw classifyTencentProviderCode(providerError.Code, response.status, providerError.Message ?? providerError.Code, body.Response?.RequestId);
    }
    if (!response.ok) {
      throw classifyProviderHttpError('tencent_eks_ci', 'provider_response', response.status, 'Tencent TKE request failed');
    }
    return body;
  } catch (error) {
    if (error instanceof ProviderLaunchError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw classifyProviderHttpError('tencent_eks_ci', 'request', 408, 'Tencent TKE request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveTencentConfig(env: Env): { region: string; image: string; callbackBaseUrl: string } {
  return {
    region: required(env.TENCENT_EKS_CI_REGION, 'TENCENT_EKS_CI_REGION'),
    image: validateDigestImage(required(env.TENCENT_EKS_CI_IMAGE, 'TENCENT_EKS_CI_IMAGE'), env.TENCENT_EKS_CI_ALLOWED_REGISTRY_HOST),
    callbackBaseUrl: trimTrailingSlash(required(env.CALLBACK_BASE_URL, 'CALLBACK_BASE_URL')),
  };
}

function resolveRegistryCredential(env: Env): TencentImageRegistryCredential | null {
  const values = [env.TENCENT_TCR_SERVER, env.TENCENT_TCR_USERNAME, env.TENCENT_TCR_PASSWORD].map((value) => value?.trim() ?? '');
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value)) {
    throw configValidationError('TENCENT_TCR_SERVER, TENCENT_TCR_USERNAME, and TENCENT_TCR_PASSWORD must be configured together');
  }
  return { Server: values[0], Username: values[1], Password: values[2], Name: 'scan-agent-registry' };
}

function validateDigestImage(image: string, allowedRegistryHost?: string): string {
  const match = image.match(/^([^/]+)\/.+@sha256:([a-f0-9]{64})$/);
  if (!match) throw configValidationError('TENCENT_EKS_CI_IMAGE must use an immutable sha256 digest');
  const allowed = allowedRegistryHost?.trim().toLowerCase();
  if (allowed && match[1].toLowerCase() !== allowed) throw configValidationError('TENCENT_EKS_CI_IMAGE registry host is not allowed');
  return image;
}

function validateContainerName(value: string): string {
  const name = value.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw configValidationError('TENCENT_EKS_CI_CONTAINER_NAME must be a DNS label');
  return name;
}

function parseSecurityGroupIds(value: string): string[] {
  const ids = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (!ids.length || ids.some((id) => !/^sg-[A-Za-z0-9]+$/.test(id))) throw configValidationError('TENCENT_EKS_CI_SECURITY_GROUP_IDS must contain valid comma-separated security group IDs');
  return ids;
}

function parseModulesForEnv(modulesJson: string): string[] {
  try {
    const parsed = JSON.parse(modulesJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((item) => String(item).trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function parsePositiveNumber(value: string | undefined, fallback: number, min: number, max: number, field: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw configValidationError(`${field} must be between ${min} and ${max}`);
  return parsed;
}

function parseInteger(value: string | undefined, fallback: number, min: number, max: number, field: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw configValidationError(`${field} must be an integer between ${min} and ${max}`);
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw configValidationError('TENCENT_EKS_CI_AUTO_CREATE_EIP must be true or false');
}

function parseEipIsp(value: string | undefined): 'BGP' | 'CMCC' | 'CTCC' | 'CUCC' {
  const normalized = (value ?? 'BGP').trim().toUpperCase();
  if (!['BGP', 'CMCC', 'CTCC', 'CUCC'].includes(normalized)) {
    throw configValidationError('TENCENT_EKS_CI_EIP_ISP must be BGP, CMCC, CTCC, or CUCC');
  }
  return normalized as 'BGP' | 'CMCC' | 'CTCC' | 'CUCC';
}

function launchResult(providerJobId: string, region: string, image: string, instance: TencentEksCi | null): AgentProviderLaunchResult {
  return {
    provider_job_id: providerJobId,
    region,
    image,
    dry_run: false,
    provider_eip_id: instance?.AutoCreatedEipId ?? null,
    provider_egress_ip: instance?.EipAddress ? normalizePublicIpv4(instance.EipAddress) : null,
  };
}

function parseApiTimeout(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_API_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_API_TIMEOUT_MS;
  return Math.max(1000, Math.min(MAX_API_TIMEOUT_MS, Math.floor(parsed)));
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw providerConfigMissing('tencent_eks_ci', name);
  return value.trim();
}

function configValidationError(message: string): ProviderLaunchError {
  return new ProviderLaunchError({ provider: 'tencent_eks_ci', phase: 'config', category: 'validation', retryable: false, safe_message: message });
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/(secret|token|authorization|password)\s*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 200);
  return 'transport error';
}
