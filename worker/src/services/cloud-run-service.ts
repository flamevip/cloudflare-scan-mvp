import type { Env } from '../env';
import type { AgentProviderLaunchResult, LaunchAgentProviderInput } from './agent-provider';
import { classifyProviderHttpError, providerConfigMissing } from './provider-errors';

interface CloudRunRunResponse {
  name?: string;
  metadata?: {
    name?: string;
  };
}

interface GoogleTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export async function launchCloudRunJob(env: Env, input: LaunchAgentProviderInput): Promise<AgentProviderLaunchResult> {
  const projectId = required(env.GCP_PROJECT_ID, 'GCP_PROJECT_ID');
  const location = required(env.GCP_LOCATION, 'GCP_LOCATION');
  const jobName = required(env.CLOUD_RUN_JOB_NAME, 'CLOUD_RUN_JOB_NAME');
  const callbackBaseUrl = trimTrailingSlash(required(env.CALLBACK_BASE_URL, 'CALLBACK_BASE_URL'));
  const dryRun = isTruthy(env.CLOUD_RUN_DRY_RUN);
  const endpoint = `https://run.googleapis.com/v2/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/jobs/${encodeURIComponent(jobName)}:run`;
  const body = buildCloudRunRunRequest(env, input, callbackBaseUrl);

  if (dryRun) {
    return {
      provider_job_id: `dry-run:${projectId}/${location}/${jobName}/${input.agent_run_id}`,
      region: location,
      image: `cloud-run-job:${jobName}`,
      dry_run: true,
    };
  }

  const accessToken = await getGoogleAccessToken(env);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw classifyProviderHttpError('gcp_cloud_run', 'provider_response', response.status, truncate(text));
  }

  const payload = text ? JSON.parse(text) as CloudRunRunResponse : {};
  return {
    provider_job_id: payload.name ?? payload.metadata?.name ?? `cloud-run:${projectId}/${location}/${jobName}/${input.agent_run_id}`,
    region: location,
    image: `cloud-run-job:${jobName}`,
    dry_run: false,
  };
}

function buildCloudRunRunRequest(env: Env, input: LaunchAgentProviderInput, callbackBaseUrl: string): unknown {
  const envVars = [
    { name: 'TASK_ID', value: input.task.id },
    { name: 'SHARD_ID', value: input.shard_id },
    { name: 'AGENT_RUN_ID', value: input.agent_run_id },
    { name: 'CALLBACK_BASE_URL', value: callbackBaseUrl },
    { name: 'CALLBACK_TOKEN', value: input.callback_token },
    { name: 'CONFIG_URL', value: `${callbackBaseUrl}/api/agent/config` },
    { name: 'TARGETS_URL', value: `${callbackBaseUrl}/api/agent/targets` },
    { name: 'CANDIDATES_URL', value: `${callbackBaseUrl}/api/agent/candidates` },
    { name: 'MODULES_JSON', value: input.task.modules_json },
    { name: 'RATE_LIMIT', value: String(input.task.rate_limit) },
    { name: 'TIMEOUT_MINUTES', value: String(input.task.timeout_minutes) },
    { name: 'AGENT_HEARTBEAT_INTERVAL_SECONDS', value: env.AGENT_HEARTBEAT_INTERVAL_SECONDS ?? '30' },
    { name: 'AGENT_MAX_CANDIDATES', value: env.AGENT_MAX_CANDIDATES ?? '500' },
    { name: 'SCAN_MODE', value: env.AGENT_SCAN_MODE ?? 'mock' },
  ];
  const containerOverride: Record<string, unknown> = { env: envVars };
  if (env.CLOUD_RUN_CONTAINER_NAME) containerOverride.name = env.CLOUD_RUN_CONTAINER_NAME;
  return { overrides: { containerOverrides: [containerOverride] } };
}

async function getGoogleAccessToken(env: Env): Promise<string> {
  if (env.GCP_ACCESS_TOKEN) return env.GCP_ACCESS_TOKEN;
  const clientEmail = required(env.GCP_CLIENT_EMAIL, 'GCP_CLIENT_EMAIL');
  const privateKey = required(env.GCP_PRIVATE_KEY, 'GCP_PRIVATE_KEY').replace(/\\n/g, '\n');
  const assertion = await createServiceAccountJwt(clientEmail, privateKey);
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const payload = await response.json<GoogleTokenResponse>();
  if (!response.ok || !payload.access_token) {
    throw classifyProviderHttpError('gcp_cloud_run', 'auth', response.status, payload.error_description ?? payload.error ?? 'unknown error', payload.error);
  }
  return payload.access_token;
}

async function createServiceAccountJwt(clientEmail: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claim)}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw providerConfigMissing('gcp_cloud_run', name);
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
