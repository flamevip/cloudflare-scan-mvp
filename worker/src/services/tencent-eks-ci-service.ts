import type { Env } from '../env';
import type { AgentProviderLaunchResult, LaunchAgentProviderInput } from './agent-provider';
import { ProviderLaunchError, classifyProviderHttpError, classifyTencentProviderCode, providerConfigMissing } from './provider-errors';

const TENCENT_TKE_ENDPOINT = 'https://tke.tencentcloudapi.com/';
const TENCENT_TKE_HOST = 'tke.tencentcloudapi.com';
const TENCENT_TKE_SERVICE = 'tke';
const TENCENT_TKE_VERSION = '2018-05-25';
const DEFAULT_API_TIMEOUT_MS = 10_000;
const MAX_API_TIMEOUT_MS = 30_000;

interface TencentEnvironmentVariable {
  Name: string;
  Value: string;
}

interface TencentContainer {
  Name: string;
  Image: string;
  EnvironmentVars: TencentEnvironmentVariable[];
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
  ImageRegistryCredentials?: TencentImageRegistryCredential[];
}

interface TencentEksCi {
  EksCiId?: string;
  EksCiName?: string;
  Status?: string;
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
    TotalCount?: number;
  };
}

export interface TencentSignedRequest {
  headers: Record<string, string>;
  body: string;
}

export interface TencentEksCiDeleteResult {
  deleted: boolean;
  already_absent: boolean;
  request_id: string | null;
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
    return { provider_job_id: ids[0], region: config.region, image: config.image, dry_run: false };
  } catch (error) {
    const shouldReconcile = !(error instanceof ProviderLaunchError) || (error.phase === 'request' && error.retryable);
    if (!shouldReconcile && error instanceof ProviderLaunchError) throw error;
    const reconciled = await reconcileTencentEksCiByName(env, eksCiName).catch(() => null);
    if (reconciled?.EksCiId) {
      return { provider_job_id: reconciled.EksCiId, region: config.region, image: config.image, dry_run: false };
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

export async function deleteTencentEksContainerInstances(env: Env, ids: string[]): Promise<TencentEksCiDeleteResult> {
  const realIds = [...new Set(ids.filter((id) => /^eksci-[A-Za-z0-9-]+$/.test(id)))].slice(0, 20);
  if (!realIds.length) return { deleted: true, already_absent: true, request_id: null };
  const region = required(env.TENCENT_EKS_CI_REGION, 'TENCENT_EKS_CI_REGION');
  const secretId = required(env.TENCENT_SECRET_ID, 'TENCENT_SECRET_ID');
  const secretKey = required(env.TENCENT_SECRET_KEY, 'TENCENT_SECRET_KEY');
  try {
    const response = await callTencentTkeApi(env, 'DeleteEKSContainerInstances', { EksCiIds: realIds }, region, secretId, secretKey);
    const confirmation = await describeTencentEksContainerInstances(env, { ids: realIds, limit: realIds.length });
    const remaining = new Set(confirmation.instances.map((instance) => instance.EksCiId).filter(Boolean));
    if (confirmation.total_count > 0 || realIds.some((id) => remaining.has(id))) {
      throw new ProviderLaunchError({
        provider: 'tencent_eks_ci',
        phase: 'cleanup',
        category: 'transient',
        retryable: true,
        safe_message: `tencent_eks_ci delete accepted but absence is not yet confirmed request_id=${response.Response?.RequestId ?? 'unknown'}`,
      });
    }
    return { deleted: true, already_absent: false, request_id: response.Response?.RequestId ?? null };
  } catch (error) {
    if (error instanceof ProviderLaunchError && /ContainerNotFound|ResourceNotFound/i.test(error.provider_code ?? '')) {
      return { deleted: true, already_absent: true, request_id: null };
    }
    throw error;
  }
}

export async function buildTencentTc3Request(
  action: string,
  payload: unknown,
  region: string,
  secretId: string,
  secretKey: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<TencentSignedRequest> {
  const body = JSON.stringify(payload);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${TENCENT_TKE_HOST}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedPayload = await sha256Hex(body);
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const credentialScope = `${date}/${TENCENT_TKE_SERVICE}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const secretDate = await hmacSha256Bytes(new TextEncoder().encode(`TC3${secretKey}`), date);
  const secretService = await hmacSha256Bytes(secretDate, TENCENT_TKE_SERVICE);
  const secretSigning = await hmacSha256Bytes(secretService, 'tc3_request');
  const signature = bytesToHex(await hmacSha256Bytes(secretSigning, stringToSign));
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    body,
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      Host: TENCENT_TKE_HOST,
      'X-TC-Action': action,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': TENCENT_TKE_VERSION,
    },
  };
}

export function isTencentEksCiDryRun(value: string | undefined): boolean {
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

function parseApiTimeout(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_API_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_API_TIMEOUT_MS;
  return Math.max(1000, Math.min(MAX_API_TIMEOUT_MS, Math.floor(parsed)));
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Bytes(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const rawKey = Uint8Array.from(keyBytes).buffer;
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/(secret|token|authorization|password)\s*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 200);
  return 'transport error';
}
