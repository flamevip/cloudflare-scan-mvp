import type { Env } from '../env';
import type { AgentIdentity } from '../types/api';
import { bearerToken } from '../auth';
import { HttpError } from '../response';

export interface ActiveAgentIdentity extends AgentIdentity {
  provider: string;
}

export async function createAgentToken(env: Env, identity: Omit<AgentIdentity, 'exp'>, ttlSeconds = 3600): Promise<string> {
  const payload: AgentIdentity = { ...identity, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await sign(env.AGENT_TOKEN_SECRET, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function agentTokenTtlSeconds(timeoutMinutes: number): number {
  const requested = Math.max(1, Math.floor(timeoutMinutes || 1)) * 60 + 10 * 60;
  return Math.max(15 * 60, Math.min(24 * 60 * 60, requested));
}

export async function requireAgentIdentity(request: Request, env: Env): Promise<ActiveAgentIdentity> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, 'missing agent bearer token');
  const identity = await verifyAgentToken(env, token);
  const run = await env.DB.prepare(`
    SELECT status, provider FROM agent_runs WHERE id = ? AND task_id = ? AND shard_id = ?
  `).bind(identity.agent_run_id, identity.task_id, identity.shard_id).first<{ status: string; provider: string }>();
  if (!run) throw new HttpError(401, 'agent run is not active');
  if (!['starting', 'running'].includes(run.status)) throw new HttpError(409, 'agent run is terminal or superseded');
  return { ...identity, provider: run.provider };
}

export async function verifyAgentToken(env: Env, token: string): Promise<AgentIdentity> {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) throw new HttpError(401, 'invalid agent token');
  const expected = await sign(env.AGENT_TOKEN_SECRET, encodedPayload);
  if (!constantTimeEqual(signature, expected)) throw new HttpError(401, 'invalid agent token signature');
  let payload: AgentIdentity;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as AgentIdentity;
  } catch {
    throw new HttpError(401, 'invalid agent token payload');
  }
  if (!payload.task_id || !payload.shard_id || !payload.agent_run_id || !payload.exp) throw new HttpError(401, 'invalid agent token payload');
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new HttpError(401, 'agent token expired');
  return payload;
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncodeBytes(new Uint8Array(sig));
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(base64);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
