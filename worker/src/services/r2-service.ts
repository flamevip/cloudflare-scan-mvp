import type { Env } from '../env';

export function taskPrefix(taskId: string): string {
  return `tenants/default/tasks/${taskId}`;
}

export function configKey(taskId: string): string {
  return `${taskPrefix(taskId)}/raw/config.json`;
}

export function targetsKey(taskId: string): string {
  return `${taskPrefix(taskId)}/raw/targets/root-targets.txt`;
}

export function targetCandidatesKey(taskId: string): string {
  return `${taskPrefix(taskId)}/raw/targets/target-urls.txt`;
}

export function externalSourcePrefix(taskId: string, shardId: string, provider: string): string {
  return `${taskPrefix(taskId)}/external/${provider}/${shardId}`;
}

export function externalSourceRawKey(taskId: string, shardId: string, provider: string, name: string): string {
  return `${externalSourcePrefix(taskId, shardId, provider)}/raw/${name}`;
}

export function externalSourceNormalizedKey(taskId: string, shardId: string, provider: string): string {
  return `${externalSourcePrefix(taskId, shardId, provider)}/normalized.jsonl`;
}

export function externalCandidatesKey(taskId: string, provider: string): string {
  return `${taskPrefix(taskId)}/external/${provider}/candidates.txt`;
}

export async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.ARTIFACTS.put(key, JSON.stringify(value, null, 2), { httpMetadata: { contentType: 'application/json' } });
}

export async function putText(env: Env, key: string, value: string, contentType = 'text/plain; charset=utf-8', customMetadata?: Record<string, string>): Promise<void> {
  await env.ARTIFACTS.put(key, value, { httpMetadata: { contentType }, customMetadata });
}

export async function getObject(env: Env, key: string): Promise<R2ObjectBody | null> {
  return env.ARTIFACTS.get(key);
}
