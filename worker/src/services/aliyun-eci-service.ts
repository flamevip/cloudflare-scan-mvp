import type { Env } from '../env';
import type { AgentProviderLaunchResult, LaunchAgentProviderInput } from './agent-provider';
import { ProviderLaunchError, classifyAliyunProviderCode, classifyProviderHttpError, providerConfigMissing } from './provider-errors';

interface AliyunEciResponse {
  ContainerGroupId?: string;
  RequestId?: string;
  Code?: string;
  Message?: string;
}

const ECI_API_VERSION = '2018-08-08';
const ECI_ENDPOINT = 'https://eci.aliyuncs.com/';
const ECI_ENV_VALUE_MAX_LENGTH = 256;

export async function launchAliyunEciContainer(env: Env, input: LaunchAgentProviderInput): Promise<AgentProviderLaunchResult> {
  const regionId = required(env.ALIYUN_REGION_ID, 'ALIYUN_REGION_ID');
  const image = required(env.ALIYUN_ECI_IMAGE, 'ALIYUN_ECI_IMAGE');
  const callbackBaseUrl = trimTrailingSlash(required(env.CALLBACK_BASE_URL, 'CALLBACK_BASE_URL'));
  const dryRun = isTruthy(env.ALIYUN_ECI_DRY_RUN);
  const containerGroupName = `scan-${input.task.id.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 24)}`;
  const params = buildCreateContainerGroupParams(env, input, regionId, image, callbackBaseUrl, containerGroupName);

  if (dryRun) {
    return {
      provider_job_id: `dry-run:aliyun-eci/${regionId}/${containerGroupName}/${input.agent_run_id}`,
      region: regionId,
      image,
      dry_run: true,
    };
  }

  const accessKeyId = required(env.ALIYUN_ACCESS_KEY_ID, 'ALIYUN_ACCESS_KEY_ID');
  const accessKeySecret = required(env.ALIYUN_ACCESS_KEY_SECRET, 'ALIYUN_ACCESS_KEY_SECRET');
  const signedParams = await signRpcParams('POST', params, accessKeyId, accessKeySecret);
  const response = await fetch(ECI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(signedParams).toString(),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as AliyunEciResponse : {};
  if (!response.ok && !payload.Code) {
    throw classifyProviderHttpError('aliyun_eci', 'provider_response', response.status, truncate(text));
  }
  if (payload.Code) {
    throw classifyAliyunProviderCode(payload.Code, response.status, payload.Message ?? payload.Code);
  }

  return {
    provider_job_id: payload.ContainerGroupId ?? payload.RequestId ?? `aliyun-eci:${regionId}/${containerGroupName}/${input.agent_run_id}`,
    region: regionId,
    image,
    dry_run: false,
  };
}

export function buildCreateContainerGroupParams(
  env: Env,
  input: LaunchAgentProviderInput,
  regionId: string,
  image: string,
  callbackBaseUrl: string,
  containerGroupName: string,
): Record<string, string> {
  const envVars = [
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
  ];
  const params: Record<string, string> = {
    Action: 'CreateContainerGroup',
    Version: ECI_API_VERSION,
    RegionId: regionId,
    ContainerGroupName: containerGroupName,
    RestartPolicy: 'Never',
    SecurityGroupId: required(env.ALIYUN_SECURITY_GROUP_ID, 'ALIYUN_SECURITY_GROUP_ID'),
    VSwitchId: required(env.ALIYUN_VSWITCH_ID, 'ALIYUN_VSWITCH_ID'),
    Cpu: env.ALIYUN_ECI_CPU || '1',
    Memory: env.ALIYUN_ECI_MEMORY || '2',
    'Container.1.Name': env.ALIYUN_ECI_CONTAINER_NAME || 'scan-agent',
    'Container.1.Image': image,
    'Container.1.ImagePullPolicy': 'Always',
  };
  if (env.ALIYUN_ZONE_ID?.trim()) params.ZoneId = env.ALIYUN_ZONE_ID.trim();
  envVars.forEach(([key, value], index) => {
    const n = index + 1;
    const stringValue = stringifyEnvValue(key, value);
    params[`Container.1.EnvironmentVar.${n}.Key`] = key;
    params[`Container.1.EnvironmentVar.${n}.Value`] = stringValue;
  });
  return params;
}

function parseModulesForEnv(modulesJson: string): string[] {
  try {
    const parsed = JSON.parse(modulesJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    const modules = parsed.map((item) => String(item).trim()).filter(Boolean);
    return modules.length ? [...new Set(modules)] : [];
  } catch {
    return [];
  }
}

function stringifyEnvValue(key: string, value: unknown): string {
  const stringValue = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  if (stringValue.length > ECI_ENV_VALUE_MAX_LENGTH) {
    throw new ProviderLaunchError({
      provider: 'aliyun_eci',
      phase: 'request',
      category: 'validation',
      retryable: false,
      safe_message: `Aliyun ECI environment variable ${key} exceeds ${ECI_ENV_VALUE_MAX_LENGTH} characters`,
    });
  }
  return stringValue;
}

async function signRpcParams(method: 'POST' | 'GET', params: Record<string, string>, accessKeyId: string, accessKeySecret: string): Promise<Record<string, string>> {
  const withCommonParams: Record<string, string> = {
    ...params,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString(),
    AccessKeyId: accessKeyId,
  };
  const canonicalized = Object.keys(withCommonParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(withCommonParams[key])}`)
    .join('&');
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonicalized)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${accessKeySecret}&`),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stringToSign));
  return { ...withCommonParams, Signature: base64Bytes(new Uint8Array(signature)) };
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw providerConfigMissing('aliyun_eci', name);
  return value.trim();
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function truncate(value: string, max = 1000): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
