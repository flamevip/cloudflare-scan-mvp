import { describe, expect, it, vi } from 'vitest';
import { apiRequest, ApiError, downloadArtifact } from '@/api/client';
import { getSessionToken, setSessionToken } from '@/api/token';

describe('API client', () => {
  it('adds the session Bearer token and unwraps the API envelope', async () => {
    setSessionToken('secret-value');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 200, message: 'ok', data: { value: 42 } }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'ray-1' } }));
    await expect(apiRequest<{ value: number }>('/api/test')).resolves.toEqual({ value: 42 });
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret-value');
  });

  it('clears the token and emits an unauthorized event on 401', async () => {
    setSessionToken('expired');
    const listener = vi.fn(); window.addEventListener('cloud-scan:unauthorized', listener);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 401, message: 'token is expired', data: {} }), { status: 401, headers: { 'X-Request-ID': 'ray-expired' } }));
    await expect(apiRequest('/api/auth/me')).rejects.toMatchObject({ status: 401, requestId: 'ray-expired' } satisfies Partial<ApiError>);
    expect(getSessionToken()).toBeNull(); expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps the session on 403 and exposes the backend message with request ID', async () => {
    setSessionToken('reader-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 403, message: 'insufficient scope', data: {} }), { status: 403, headers: { 'X-Request-ID': 'ray-forbidden' } }));
    await expect(apiRequest('/api/admin/users')).rejects.toMatchObject({
      status: 403,
      backendMessage: 'insufficient scope',
      message: 'insufficient scope（Request ID：ray-forbidden）',
      requestId: 'ray-forbidden',
    } satisfies Partial<ApiError>);
    expect(getSessionToken()).toBe('reader-token');
  });

  it('downloads artifacts with authorization and releases the object URL', async () => {
    setSessionToken('artifact-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['result']), { status: 200 }));
    const createUrl = vi.fn(() => 'blob:artifact'); const revokeUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeUrl, configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await downloadArtifact('artifact_1', 'raw');
    expect(click).toHaveBeenCalledOnce(); expect(revokeUrl).toHaveBeenCalledWith('blob:artifact');
  });
});
