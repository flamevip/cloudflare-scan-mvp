export function ok(data: unknown = {}, init?: ResponseInit): Response {
  return json({ code: 200, message: 'ok', data }, init);
}

export function error(code: number, message: string, data: unknown = {}): Response {
  return json({ code, message, data }, { status: code >= 400 ? code : 400 });
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid json body');
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function handleErrors(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return error(err.status, err.message);
    const message = err instanceof Error ? err.message : 'internal error';
    return error(500, message);
  }
}
