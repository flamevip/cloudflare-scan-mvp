import type { AuthContext } from '../auth';
import type { Env } from '../env';
import { projectFilter } from '../auth';
import { HttpError } from '../response';
import { requireTaskAccess } from './task-service';
import { isTruthy, parseBoundedInteger, validateRuntimeConfig } from './config-validation';

export interface SearchParams {
  q: string;
  task_id: string | null;
  type: string | null;
  limit: number;
}

interface ArtifactSearchRow {
  artifact_id: string;
  task_id: string;
  type: string;
  search_r2_key: string | null;
  raw_r2_key: string;
  created_at: string;
}

interface SearchChunk {
  r2_key: string | null;
  text: string;
  score: number | null;
  raw: unknown;
}

interface SearchMetadata {
  duration_ms: number;
  chunks_seen: number;
  chunks_with_r2_key: number;
  mapping_misses: number;
  items_authorized: number;
  items_returned: number;
}

interface CountRow {
  count: number;
}

export async function searchArtifacts(env: Env, context: AuthContext, url: URL): Promise<unknown> {
  const started = Date.now();
  const params = parseSearchParams(url, env.AI_SEARCH_LIMIT);
  if (params.task_id) await requireTaskAccess(env, context, params.task_id);

  const metadata = emptyMetadata(started);
  if (!isTruthy(env.AI_SEARCH_ENABLED) || !env.AI_SEARCH) {
    return degradedResponse(params, 'ai_search_unconfigured', 'AI Search binding is not configured or AI_SEARCH_ENABLED is not true', finalizeMetadata(metadata, started));
  }

  let aiPayload: unknown;
  try {
    aiPayload = await env.AI_SEARCH.search({
      messages: [{ role: 'user', content: params.q }],
      limit: params.limit,
    });
  } catch (err) {
    return degradedResponse(params, 'ai_search_failed', safeErrorMessage(err, 'AI Search request failed'), finalizeMetadata(metadata, started));
  }

  const chunks = extractSearchChunks(aiPayload).slice(0, params.limit * 2);
  metadata.chunks_seen = chunks.length;
  metadata.chunks_with_r2_key = chunks.filter((chunk) => Boolean(chunk.r2_key)).length;
  const items = [];
  for (const chunk of chunks) {
    const mapped = await mapChunkToAuthorizedArtifact(env, context, chunk, params);
    if (mapped) {
      items.push(mapped);
      metadata.items_authorized += 1;
    } else {
      metadata.mapping_misses += 1;
    }
    if (items.length >= params.limit) break;
  }
  metadata.items_returned = items.length;
  return { degraded: false, query: params.q, task_id: params.task_id, type: params.type, items, metadata: finalizeMetadata(metadata, started) };
}

export async function getSearchStatus(env: Env): Promise<unknown> {
  const validation = validateRuntimeConfig(env);
  const limit = parseBoundedInteger(env.AI_SEARCH_LIMIT, 10, 1, 20);
  const status: Record<string, unknown> = {
    enabled: isTruthy(env.AI_SEARCH_ENABLED),
    binding_present: Boolean(env.AI_SEARCH),
    limit: limit.value,
    limit_valid: limit.valid,
    info_available: typeof env.AI_SEARCH?.info === 'function',
    stats_available: typeof env.AI_SEARCH?.stats === 'function',
    info_ok: null,
    stats_ok: null,
    artifact_search_docs_count: await countSearchDocs(env),
    config: validation,
    last_error: null,
  };

  if (typeof env.AI_SEARCH?.info === 'function') {
    try {
      status.info = await env.AI_SEARCH.info();
      status.info_ok = true;
    } catch (err) {
      status.info_ok = false;
      status.last_error = { code: 'ai_search_info_failed', message: safeErrorMessage(err, 'AI Search info failed') };
    }
  }

  if (typeof env.AI_SEARCH?.stats === 'function') {
    try {
      status.stats = await env.AI_SEARCH.stats();
      status.stats_ok = true;
    } catch (err) {
      status.stats_ok = false;
      status.last_error = { code: 'ai_search_stats_failed', message: safeErrorMessage(err, 'AI Search stats failed') };
    }
  }

  return status;
}

export function parseSearchParams(url: URL, envLimit?: string): SearchParams {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) throw new HttpError(400, 'q is required');
  if (q.length > 500) throw new HttpError(400, 'q exceeds 500 characters');
  const taskId = emptyToNull(url.searchParams.get('task_id'));
  if (taskId && taskId.length > 80) throw new HttpError(400, 'task_id is too long');
  const type = emptyToNull(url.searchParams.get('type'));
  if (type && !/^[a-zA-Z0-9_-]{1,64}$/.test(type)) throw new HttpError(400, 'type filter is invalid');
  const defaultLimit = clampNumber(envLimit, 10, 1, 20);
  const limit = clampNumber(url.searchParams.get('limit'), defaultLimit, 1, 20);
  return { q, task_id: taskId, type, limit };
}

export function extractR2Key(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const metadata = typeof record.metadata === 'object' && record.metadata !== null ? record.metadata as Record<string, unknown> : {};
  const customMetadata = typeof record.customMetadata === 'object' && record.customMetadata !== null ? record.customMetadata as Record<string, unknown> : {};
  const item = typeof record.item === 'object' && record.item !== null ? record.item as Record<string, unknown> : {};
  const itemMetadata = typeof item.metadata === 'object' && item.metadata !== null ? item.metadata as Record<string, unknown> : {};
  return firstString(
    record.r2_key,
    record.key,
    record.path,
    record.name,
    record.filename,
    record.objectKey,
    metadata.r2_key,
    metadata.key,
    metadata.path,
    metadata.source,
    customMetadata.r2_key,
    customMetadata.key,
    item.r2_key,
    item.key,
    item.path,
    item.name,
    itemMetadata.r2_key,
    itemMetadata.key,
  );
}

export function parseTaskIdFromSearchKey(key: string): string | null {
  const match = key.match(/(?:^|\/)tasks\/([^/]+)\//);
  return match?.[1] ?? null;
}

function extractSearchChunks(payload: unknown): SearchChunk[] {
  const arrays = collectArrays(payload);
  const chunks: SearchChunk[] = [];
  for (const item of arrays.flat()) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    chunks.push({
      r2_key: extractR2Key(record),
      text: firstString(record.text, record.content, record.chunk, record.snippet) ?? '',
      score: firstNumber(record.score, record.similarity, record.rank) ?? null,
      raw: record,
    });
  }
  return chunks;
}

async function mapChunkToAuthorizedArtifact(env: Env, context: AuthContext, chunk: SearchChunk, params: SearchParams): Promise<unknown | null> {
  if (chunk.r2_key) {
    const artifact = await findArtifactBySearchKey(env, context, chunk.r2_key, params);
    if (artifact) return formatSearchResult(artifact, chunk, 'search_r2_key');
  }
  return null;
}

async function findArtifactBySearchKey(env: Env, context: AuthContext, key: string, params: SearchParams): Promise<ArtifactSearchRow | null> {
  const filter = projectFilter(context, 't');
  const clauses = [`ar.search_r2_key = ?`, filter.sql];
  const bindings: unknown[] = [key, ...filter.bindings];
  if (params.task_id) {
    clauses.push('ar.task_id = ?');
    bindings.push(params.task_id);
  }
  if (params.type) {
    clauses.push('ar.type = ?');
    bindings.push(params.type);
  }
  const row = await env.DB.prepare(`
    SELECT ar.id AS artifact_id, ar.task_id, ar.type, ar.search_r2_key, ar.raw_r2_key, ar.created_at
    FROM artifacts ar INNER JOIN tasks t ON t.id = ar.task_id
    WHERE ${clauses.join(' AND ')}
    LIMIT 1
  `).bind(...bindings).first<ArtifactSearchRow>();
  return row ?? null;
}

function formatSearchResult(artifact: ArtifactSearchRow, chunk: SearchChunk, mapping: string): unknown {
  return {
    mapping,
    task_id: artifact.task_id,
    artifact_id: artifact.artifact_id,
    type: artifact.type,
    score: chunk.score,
    snippet: truncate(chunk.text, 500),
    created_at: artifact.created_at,
  };
}

function degradedResponse(params: SearchParams, code: string, message: string, metadata: SearchMetadata): unknown {
  return { degraded: true, query: params.q, task_id: params.task_id, type: params.type, items: [], error: { code, message }, metadata };
}

function emptyMetadata(started: number): SearchMetadata {
  return { duration_ms: Math.max(0, Date.now() - started), chunks_seen: 0, chunks_with_r2_key: 0, mapping_misses: 0, items_authorized: 0, items_returned: 0 };
}

function finalizeMetadata(metadata: SearchMetadata, started: number): SearchMetadata {
  return { ...metadata, duration_ms: Math.max(0, Date.now() - started) };
}

async function countSearchDocs(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE search_r2_key IS NOT NULL').first<CountRow>();
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}

function safeErrorMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : fallback;
  return message.replace(/(token|secret|key|password)=([^\s&]+)/gi, '$1=[redacted]').slice(0, 240);
}

function collectArrays(payload: unknown): unknown[][] {
  if (Array.isArray(payload)) return [payload];
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const arrays = [record.results, record.items, record.chunks, record.matches, record.data, (record.data as Record<string, unknown> | undefined)?.results, (record.data as Record<string, unknown> | undefined)?.chunks];
  return arrays.filter((value): value is unknown[] => Array.isArray(value));
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function emptyToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value ?? fallback);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
