import type { ApiEnvelope } from './contracts';
import { clearSessionToken, getSessionToken } from './token';

export class ApiError extends Error {
  public readonly backendMessage: string;

  constructor(
    public readonly status: number,
    public readonly code: number,
    message: string,
    public readonly requestId: string | null,
    public readonly data: unknown,
  ) {
    super(requestId ? `${message}（Request ID：${requestId}）` : message);
    this.name = 'ApiError';
    this.backendMessage = message;
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  auth?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.auth !== false) {
    const token = getSessionToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const requestId = response.headers.get('X-Request-ID');
  let envelope: ApiEnvelope<T>;
  try {
    envelope = await response.json() as ApiEnvelope<T>;
  } catch {
    throw new ApiError(response.status, response.status, '服务器返回了无法解析的响应', requestId, null);
  }

  if (!response.ok || envelope.code >= 400) {
    if (response.status === 401) {
      clearSessionToken();
      window.dispatchEvent(new CustomEvent('cloud-scan:unauthorized'));
    }
    throw new ApiError(response.status, envelope.code, envelope.message || '请求失败', requestId, envelope.data);
  }
  return envelope.data;
}

export function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const value = query.toString();
  return value ? `?${value}` : '';
}

export async function downloadArtifact(artifactId: string, kind: 'raw' | 'search'): Promise<void> {
  const headers = new Headers();
  const token = getSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/download?type=${kind}`, { headers });
  if (!response.ok) {
    let message = '产物下载失败';
    try {
      const body = await response.json() as ApiEnvelope<unknown>;
      message = body.message || message;
    } catch { /* keep safe fallback */ }
    if (response.status === 401) {
      clearSessionToken();
      window.dispatchEvent(new CustomEvent('cloud-scan:unauthorized'));
    }
    throw new ApiError(response.status, response.status, message, response.headers.get('X-Request-ID'), null);
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${artifactId}-${kind}`;
  anchor.click();
  URL.revokeObjectURL(href);
}
