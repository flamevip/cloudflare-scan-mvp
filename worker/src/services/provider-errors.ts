import type { ExternalAgentProvider } from './agent-provider';

export type ProviderErrorPhase = 'config' | 'auth' | 'request' | 'provider_response' | 'parse' | 'cleanup' | 'unknown';
export type ProviderErrorCategory = 'config_missing' | 'auth_failed' | 'validation' | 'quota' | 'rate_limited' | 'transient' | 'pending' | 'unknown';

export class ProviderLaunchError extends Error {
  provider: ExternalAgentProvider;
  phase: ProviderErrorPhase;
  category: ProviderErrorCategory;
  retryable: boolean;
  http_status?: number;
  provider_code?: string;
  safe_message: string;

  constructor(input: {
    provider: ExternalAgentProvider;
    phase: ProviderErrorPhase;
    category: ProviderErrorCategory;
    retryable: boolean;
    safe_message: string;
    http_status?: number;
    provider_code?: string;
  }) {
    super(input.safe_message);
    this.name = 'ProviderLaunchError';
    this.provider = input.provider;
    this.phase = input.phase;
    this.category = input.category;
    this.retryable = input.retryable;
    this.http_status = input.http_status;
    this.provider_code = input.provider_code;
    this.safe_message = input.safe_message;
  }
}

export function providerConfigMissing(provider: ExternalAgentProvider, field: string): ProviderLaunchError {
  return new ProviderLaunchError({ provider, phase: 'config', category: 'config_missing', retryable: false, safe_message: `${field} is required for ${provider}` });
}

export function classifyProviderHttpError(provider: ExternalAgentProvider, phase: ProviderErrorPhase, status: number, message: string, providerCode?: string): ProviderLaunchError {
  const category = classifyStatus(status, providerCode);
  return new ProviderLaunchError({
    provider,
    phase,
    category,
    retryable: isRetryableStatus(status, providerCode),
    http_status: status,
    provider_code: providerCode,
    safe_message: `${provider} ${phase} failed (${status}${providerCode ? ` ${providerCode}` : ''}): ${sanitizeProviderMessage(message)}`,
  });
}

export function classifyAliyunProviderCode(code: string | undefined, status = 200, message = code ?? 'Aliyun ECI error'): ProviderLaunchError {
  const normalized = String(code ?? '').toLowerCase();
  let category: ProviderErrorCategory = 'unknown';
  let retryable = false;
  if (/throttl|limit|qps|flow/.test(normalized)) {
    category = 'rate_limited';
    retryable = true;
  } else if (/serviceunavailable|internal|timeout|temporar|busy|tryagain/.test(normalized) || status >= 500) {
    category = 'transient';
    retryable = true;
  } else if (/auth|signature|forbidden|denied|invalidaccesskey/.test(normalized) || status === 401 || status === 403) {
    category = 'auth_failed';
  } else if (/invalid|missing|unsupported|malformed|badrequest/.test(normalized) || status === 400) {
    category = 'validation';
  }
  return new ProviderLaunchError({
    provider: 'aliyun_eci',
    phase: category === 'auth_failed' ? 'auth' : 'provider_response',
    category,
    retryable,
    http_status: status,
    provider_code: code,
    safe_message: `aliyun_eci provider_response failed (${status}${code ? ` ${code}` : ''}): ${sanitizeProviderMessage(message)}`,
  });
}

export function classifyTencentProviderCode(code: string | undefined, status = 200, message = code ?? 'Tencent EKS CI error', requestId?: string): ProviderLaunchError {
  const normalized = String(code ?? '').toLowerCase();
  let category: ProviderErrorCategory = 'unknown';
  let retryable = false;
  if (/requestlimit|limitexceeded|throttl|frequency/.test(normalized)) {
    category = 'rate_limited';
    retryable = true;
  } else if (/auth|signature|unauthorized|camnoauth|forbidden|secretid|secretkey/.test(normalized) || status === 401 || status === 403) {
    category = 'auth_failed';
  } else if (/quota|resourceinsufficient|insufficient|resourceunavailable/.test(normalized)) {
    category = 'quota';
  } else if (/invalidparameter|unsupported|malformed|missingparameter|internalerror\.param/.test(normalized) || status === 400) {
    category = 'validation';
  } else if (/internalerror|serviceunavailable|timeout|temporar|unavailable|cmdtimeout/.test(normalized) || status >= 500) {
    category = 'transient';
    retryable = true;
  }
  const requestSuffix = requestId ? ` request_id=${sanitizeProviderMessage(requestId)}` : '';
  return new ProviderLaunchError({
    provider: 'tencent_eks_ci',
    phase: category === 'auth_failed' ? 'auth' : 'provider_response',
    category,
    retryable,
    http_status: status,
    provider_code: code,
    safe_message: `tencent_eks_ci provider_response failed (${status}${code ? ` ${code}` : ''}): ${sanitizeProviderMessage(message)}${requestSuffix}`,
  });
}

export function toProviderLaunchError(err: unknown, provider: ExternalAgentProvider): ProviderLaunchError {
  if (err instanceof ProviderLaunchError) return err;
  const message = err instanceof Error ? err.message : 'provider launch failed';
  const missing = message.match(/^([A-Z0-9_]+) is required/);
  if (missing) return providerConfigMissing(provider, missing[1]);
  return new ProviderLaunchError({ provider, phase: 'unknown', category: 'unknown', retryable: true, safe_message: `${provider} launch failed: ${sanitizeProviderMessage(message)}` });
}

export function serializeProviderError(err: ProviderLaunchError): Record<string, unknown> {
  return {
    provider: err.provider,
    phase: err.phase,
    category: err.category,
    retryable: err.retryable,
    http_status: err.http_status ?? null,
    provider_code: err.provider_code ?? null,
    safe_message: err.safe_message,
  };
}

function classifyStatus(status: number, providerCode?: string): ProviderErrorCategory {
  if (providerCode && /quota/i.test(providerCode)) return 'quota';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 408 || status === 409 || status === 429) return status === 429 ? 'rate_limited' : 'transient';
  if (status >= 500) return 'transient';
  if (status >= 400) return 'validation';
  return 'unknown';
}

function isRetryableStatus(status: number, providerCode?: string): boolean {
  const category = classifyStatus(status, providerCode);
  return category === 'transient' || category === 'rate_limited';
}

function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/(token|secret(?:id|key)?|key|password|authorization|x-tc-[a-z-]+)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/(TC3-HMAC-SHA256\s+Credential=)[^,\s]+/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .slice(0, 300);
}
