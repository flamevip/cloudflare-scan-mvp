import type { Env } from '../env';

export type ConfigIssueSeverity = 'error' | 'warning';

export interface ConfigIssue {
  severity: ConfigIssueSeverity;
  code: string;
  field: string;
  message: string;
}

export interface RuntimeConfigValidation {
  ok: boolean;
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
}

const KNOWN_AGENT_PROVIDERS = new Set(['mock', 'manual', 'gcp_cloud_run', 'aliyun_eci', 'tencent_eks_ci', 'auto', undefined]);

export function validateRuntimeConfig(env: Env): RuntimeConfigValidation {
  const issues: ConfigIssue[] = [];
  const aiSearchEnabled = isTruthy(env.AI_SEARCH_ENABLED);
  if (aiSearchEnabled && !env.AI_SEARCH) {
    issues.push(errorIssue('ai_search_binding_missing', 'AI_SEARCH', 'AI_SEARCH_ENABLED is true but the AI_SEARCH binding is not configured'));
  }
  validateInteger(env.AI_SEARCH_LIMIT, 'AI_SEARCH_LIMIT', 1, 20, issues);
  validateInteger(env.TASK_MAX_RETRY, 'TASK_MAX_RETRY', 0, 5, issues);
  validateInteger(env.AGENT_HEARTBEAT_TIMEOUT_SECONDS, 'AGENT_HEARTBEAT_TIMEOUT_SECONDS', 60, 24 * 60 * 60, issues);
  validateInteger(env.AGENT_HEARTBEAT_INTERVAL_SECONDS, 'AGENT_HEARTBEAT_INTERVAL_SECONDS', 5, 300, issues);
  validateInteger(env.AGENT_MAX_CANDIDATES, 'AGENT_MAX_CANDIDATES', 1, 500, issues);
  validateInteger(env.ARTIFACT_RETENTION_DAYS, 'ARTIFACT_RETENTION_DAYS', 1, 365, issues);
  validateInteger(env.METADATA_RETENTION_DAYS, 'METADATA_RETENTION_DAYS', 30, 3650, issues);
  validateInteger(env.AUDIT_RETENTION_DAYS, 'AUDIT_RETENTION_DAYS', 30, 3650, issues);
  if (env.TOKEN_SCOPE_ENFORCEMENT && !['report', 'enforce'].includes(env.TOKEN_SCOPE_ENFORCEMENT)) {
    issues.push(errorIssue('token_scope_enforcement_invalid', 'TOKEN_SCOPE_ENFORCEMENT', 'TOKEN_SCOPE_ENFORCEMENT must be report or enforce'));
  }

  if (!KNOWN_AGENT_PROVIDERS.has(env.AGENT_PROVIDER)) {
    issues.push(errorIssue('agent_provider_unknown', 'AGENT_PROVIDER', 'AGENT_PROVIDER must be mock, manual, gcp_cloud_run, aliyun_eci, tencent_eks_ci, or auto'));
  }

  const provider = env.AGENT_PROVIDER;
  if (provider === 'gcp_cloud_run' || provider === 'auto') validateCloudRunConfig(env, issues, provider === 'auto');
  if (provider === 'aliyun_eci' || provider === 'auto') validateAliyunConfig(env, issues, provider === 'auto');
  if (provider === 'tencent_eks_ci') validateTencentEksCiConfig(env, issues);

  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    errors: issues.filter((issue) => issue.severity === 'error'),
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}

export function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

export function parseBoundedInteger(value: unknown, fallback: number, min: number, max: number): { value: number; valid: boolean } {
  if (value === undefined || value === null || value === '') return { value: fallback, valid: true };
  const num = Number(value);
  if (!Number.isFinite(num) || Math.floor(num) !== num || num < min || num > max) return { value: fallback, valid: false };
  return { value: num, valid: true };
}

function validateCloudRunConfig(env: Env, issues: ConfigIssue[], auto: boolean): void {
  for (const field of ['CALLBACK_BASE_URL', 'GCP_PROJECT_ID', 'GCP_LOCATION', 'CLOUD_RUN_JOB_NAME'] as const) {
    if (!env[field]) issues.push(configMissing(field, 'gcp_cloud_run', auto));
  }
}

function validateAliyunConfig(env: Env, issues: ConfigIssue[], auto: boolean): void {
  for (const field of ['CALLBACK_BASE_URL', 'ALIYUN_REGION_ID', 'ALIYUN_SECURITY_GROUP_ID', 'ALIYUN_VSWITCH_ID', 'ALIYUN_ECI_IMAGE'] as const) {
    if (!env[field]) issues.push(configMissing(field, 'aliyun_eci', auto));
  }
}

function validateTencentEksCiConfig(env: Env, issues: ConfigIssue[]): void {
  for (const field of ['CALLBACK_BASE_URL', 'TENCENT_EKS_CI_REGION', 'TENCENT_EKS_CI_VPC_ID', 'TENCENT_EKS_CI_SUBNET_ID', 'TENCENT_EKS_CI_SECURITY_GROUP_IDS', 'TENCENT_EKS_CI_IMAGE'] as const) {
    if (!env[field]?.trim()) issues.push(configMissing(field, 'tencent_eks_ci', false));
  }
  if (env.CALLBACK_BASE_URL) {
    try {
      const callback = new URL(env.CALLBACK_BASE_URL);
      if (env.ENV !== 'dev' && callback.protocol !== 'https:') issues.push(errorIssue('provider_callback_https_required', 'CALLBACK_BASE_URL', 'Tencent EKS CI requires an HTTPS callback URL outside local development'));
    } catch {
      issues.push(errorIssue('provider_callback_invalid', 'CALLBACK_BASE_URL', 'CALLBACK_BASE_URL must be a valid URL'));
    }
  }
  if (env.TENCENT_EKS_CI_SECURITY_GROUP_IDS) {
    const ids = env.TENCENT_EKS_CI_SECURITY_GROUP_IDS.split(',').map((value) => value.trim()).filter(Boolean);
    if (!ids.length || ids.some((id) => !/^sg-[A-Za-z0-9]+$/.test(id))) issues.push(errorIssue('provider_config_invalid', 'TENCENT_EKS_CI_SECURITY_GROUP_IDS', 'Tencent security group IDs must be valid comma-separated sg-* identifiers'));
  }
  if (env.TENCENT_EKS_CI_IMAGE) {
    const match = env.TENCENT_EKS_CI_IMAGE.match(/^([^/]+)\/.+@sha256:[a-f0-9]{64}$/);
    if (!match) issues.push(errorIssue('provider_image_digest_required', 'TENCENT_EKS_CI_IMAGE', 'Tencent EKS CI image must use an immutable sha256 digest'));
    const allowedHost = env.TENCENT_EKS_CI_ALLOWED_REGISTRY_HOST?.trim().toLowerCase();
    if (match && allowedHost && match[1].toLowerCase() !== allowedHost) issues.push(errorIssue('provider_registry_not_allowed', 'TENCENT_EKS_CI_IMAGE', 'Tencent EKS CI image registry host is not allowed'));
  }
  validateNumber(env.TENCENT_EKS_CI_CPU, 'TENCENT_EKS_CI_CPU', 0.25, 64, issues);
  validateNumber(env.TENCENT_EKS_CI_MEMORY, 'TENCENT_EKS_CI_MEMORY', 0.5, 256, issues);
  validateInteger(env.TENCENT_EKS_CI_API_TIMEOUT_MS, 'TENCENT_EKS_CI_API_TIMEOUT_MS', 1000, 30000, issues);
  const registryParts = [env.TENCENT_TCR_SERVER, env.TENCENT_TCR_USERNAME, env.TENCENT_TCR_PASSWORD].map((value) => Boolean(value?.trim()));
  if (registryParts.some(Boolean) && !registryParts.every(Boolean)) issues.push(errorIssue('provider_registry_credentials_incomplete', 'TENCENT_TCR_SERVER', 'Tencent TCR server, username, and password must be configured together'));
}

function validateNumber(value: unknown, field: string, min: number, max: number, issues: ConfigIssue[]): void {
  if (value === undefined || value === null || value === '') return;
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) issues.push(errorIssue('invalid_number_range', field, `${field} must be a number between ${min} and ${max}`));
}

function validateInteger(value: unknown, field: string, min: number, max: number, issues: ConfigIssue[]): void {
  if (value === undefined || value === null || value === '') return;
  const num = Number(value);
  if (!Number.isFinite(num) || Math.floor(num) !== num || num < min || num > max) {
    issues.push(errorIssue('invalid_integer_range', field, `${field} must be an integer between ${min} and ${max}`));
  }
}

function configMissing(field: string, provider: string, auto: boolean): ConfigIssue {
  return errorIssue('provider_config_missing', field, `${field} is required for ${auto ? `auto candidate ${provider}` : `${provider} provider`}`);
}

function errorIssue(code: string, field: string, message: string): ConfigIssue {
  return { severity: 'error', code, field, message };
}
