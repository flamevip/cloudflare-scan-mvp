import type { Env } from '../env';
import { newId, nowIso } from '../ids';
import { assertAssetInScope } from './scope-validation';
import { externalCandidatesKey, externalSourceNormalizedKey, externalSourceRawKey, putText } from './r2-service';

const PROVIDER = 'hunter';

export interface HunterConfig {
  enabled: boolean;
  apiKey: string | null;
  baseUrl: string;
  pageSize: number;
  maxPages: number;
  maxResults: number;
  timeoutMs: number;
  queryTemplate: string;
}

export interface HunterCandidate {
  asset_key: string;
  url: string;
  host: string;
  port: number;
  scheme: string;
  source: 'hunter';
  title?: string;
  status_code?: number;
  payload: Record<string, unknown>;
}

export interface HunterRunInput {
  task_id: string;
  shard_id: string;
  targets: string[];
  external_sources: string[];
}

export interface HunterRunResult {
  status: 'skipped' | 'success' | 'failed';
  requested: boolean;
  retryable: boolean;
  message: string;
  raw_keys: string[];
  normalized_key?: string;
  candidates_key?: string;
  candidate_count: number;
}

export function readHunterConfig(env: Env): HunterConfig {
  return {
    enabled: isTruthy(env.HUNTER_ENABLED),
    apiKey: env.HUNTER_API_KEY?.trim() || null,
    baseUrl: env.HUNTER_BASE_URL?.trim() || 'https://hunter.qianxin.com/openApi/search',
    pageSize: clampNumber(env.HUNTER_PAGE_SIZE, 20, 1, 100),
    maxPages: clampNumber(env.HUNTER_MAX_PAGES, 1, 1, 10),
    maxResults: clampNumber(env.HUNTER_MAX_RESULTS, 100, 1, 1000),
    timeoutMs: clampNumber(env.HUNTER_TIMEOUT_MS, 5000, 500, 30000),
    queryTemplate: env.HUNTER_QUERY_TEMPLATE?.trim() || 'domain="{domain}"',
  };
}

export function shouldRunHunter(externalSources: string[]): boolean {
  return externalSources.map((source) => source.toLowerCase()).includes(PROVIDER);
}

export function buildHunterQuery(rootDomain: string, config: Pick<HunterConfig, 'queryTemplate'>): string {
  const domain = rootDomain.trim().toLowerCase();
  return config.queryTemplate.replaceAll('{domain}', domain);
}

export async function runHunterEnrichment(env: Env, input: HunterRunInput): Promise<HunterRunResult> {
  const requested = shouldRunHunter(input.external_sources);
  const rawKeys: string[] = [];
  if (!requested) {
    return { status: 'skipped', requested, retryable: false, message: 'hunter external source not requested', raw_keys: rawKeys, candidate_count: 0 };
  }

  const config = readHunterConfig(env);
  if (!config.enabled) {
    const result = { status: 'skipped' as const, requested, retryable: false, message: 'HUNTER_ENABLED is not true', raw_keys: rawKeys, candidate_count: 0 };
    await auditHunter(env, input.task_id, result);
    return result;
  }
  if (!config.apiKey) {
    const result = { status: 'failed' as const, requested, retryable: false, message: 'HUNTER_API_KEY is required when Hunter is enabled', raw_keys: rawKeys, candidate_count: 0 };
    await auditHunter(env, input.task_id, result);
    return result;
  }

  try {
    const candidates = new Map<string, HunterCandidate>();
    let pageCount = 0;
    for (const root of input.targets) {
      const query = buildHunterQuery(root, config);
      for (let page = 1; page <= config.maxPages && candidates.size < config.maxResults; page += 1) {
        pageCount += 1;
        const payload = await fetchHunterPage(config, query, page);
        const rawKey = externalSourceRawKey(input.task_id, input.shard_id, PROVIDER, `${root}-page-${page}.json`);
        rawKeys.push(rawKey);
        await putText(env, rawKey, JSON.stringify(payload, null, 2), 'application/json; charset=utf-8');
        for (const record of extractHunterRecords(payload)) {
          const candidate = normalizeHunterRecord(record, input.targets);
          if (candidate) candidates.set(candidate.asset_key, candidate);
          if (candidates.size >= config.maxResults) break;
        }
        if (!hasMoreHunterResults(payload, page, config.pageSize)) break;
      }
    }

    const candidateList = [...candidates.values()];
    const normalizedKey = externalSourceNormalizedKey(input.task_id, input.shard_id, PROVIDER);
    const candidatesKey = externalCandidatesKey(input.task_id, PROVIDER);
    const normalizedJsonl = candidateList.map((candidate) => JSON.stringify(candidate)).join('\n') + (candidateList.length ? '\n' : '');
    const candidateText = candidateList.map((candidate) => candidate.url).join('\n') + (candidateList.length ? '\n' : '');
    await putText(env, normalizedKey, normalizedJsonl, 'application/jsonl; charset=utf-8');
    await putText(env, candidatesKey, candidateText, 'text/plain; charset=utf-8');
    await upsertHunterResults(env, input.task_id, candidateList);

    const result = {
      status: 'success' as const,
      requested,
      retryable: false,
      message: `hunter completed: ${candidateList.length} candidate(s), ${pageCount} page(s)`,
      raw_keys: rawKeys,
      normalized_key: normalizedKey,
      candidates_key: candidatesKey,
      candidate_count: candidateList.length,
    };
    await auditHunter(env, input.task_id, result);
    return result;
  } catch (err) {
    const retryable = err instanceof HunterProviderError ? err.retryable : true;
    const result = {
      status: 'failed' as const,
      requested,
      retryable,
      message: err instanceof Error ? err.message : 'Hunter provider failed',
      raw_keys: rawKeys,
      candidate_count: 0,
    };
    await auditHunter(env, input.task_id, result);
    return result;
  }
}

export function normalizeHunterRecord(record: Record<string, unknown>, allowedRoots: string[]): HunterCandidate | null {
  const rawUrl = firstString(record.url, record.link, record.web_url);
  const rawHost = firstString(record.host, record.domain, record.hostname, record.site, record.ip_domain);
  const parsed = parseCandidateEndpoint(rawUrl, rawHost, record);
  if (!parsed) return null;
  try {
    assertAssetInScope(parsed.host, allowedRoots);
  } catch {
    return null;
  }
  return {
    asset_key: `${parsed.scheme}:${parsed.host}:${parsed.port}`,
    url: parsed.url,
    host: parsed.host,
    port: parsed.port,
    scheme: parsed.scheme,
    source: PROVIDER,
    title: firstString(record.title, record.web_title),
    status_code: firstNumber(record.status_code, record.status),
    payload: record,
  };
}

async function fetchHunterPage(config: HunterConfig, query: string, page: number): Promise<unknown> {
  const url = new URL(config.baseUrl);
  url.searchParams.set('api-key', config.apiKey ?? '');
  url.searchParams.set('search', query);
  url.searchParams.set('page', String(page));
  url.searchParams.set('page_size', String(config.pageSize));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new HunterProviderError(`Hunter request failed (${response.status}): ${truncate(text)}`, response.status === 429 || response.status >= 500);
    }
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err instanceof HunterProviderError) throw err;
    throw new HunterProviderError(err instanceof Error ? err.message : 'Hunter request failed', true);
  } finally {
    clearTimeout(timeout);
  }
}

function extractHunterRecords(payload: unknown): Record<string, unknown>[] {
  const value = payload as Record<string, unknown>;
  const candidates = [value.data, (value.data as Record<string, unknown> | undefined)?.arr, value.arr, value.list, value.results, value.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  }
  return [];
}

function hasMoreHunterResults(payload: unknown, page: number, pageSize: number): boolean {
  const records = extractHunterRecords(payload);
  if (records.length < pageSize) return false;
  const value = payload as Record<string, unknown>;
  const total = firstNumber(value.total, (value.data as Record<string, unknown> | undefined)?.total);
  return total === undefined ? records.length === pageSize : page * pageSize < total;
}

function parseCandidateEndpoint(rawUrl: string | undefined, rawHost: string | undefined, record: Record<string, unknown>): { url: string; host: string; port: number; scheme: string } | null {
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `https://${rawUrl}`);
      const scheme = parsed.protocol.replace(':', '') || 'https';
      const port = Number(parsed.port || (scheme === 'http' ? 80 : 443));
      return { url: parsed.toString(), host: parsed.hostname.toLowerCase(), port, scheme };
    } catch {
      return null;
    }
  }
  if (!rawHost) return null;
  const host = rawHost.trim().toLowerCase();
  const scheme = firstString(record.protocol, record.scheme) ?? 'https';
  const port = firstNumber(record.port) ?? (scheme === 'http' ? 80 : 443);
  return { url: `${scheme}://${host}${defaultPort(scheme, port) ? '' : `:${port}`}`, host, port, scheme };
}

async function upsertHunterResults(env: Env, taskId: string, candidates: HunterCandidate[]): Promise<void> {
  const now = nowIso();
  for (const candidate of candidates) {
    await env.DB.prepare(`
      INSERT INTO external_source_results (id, task_id, provider, asset_key, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, provider, asset_key) DO UPDATE SET payload_json = excluded.payload_json
    `).bind(newId('extsrc'), taskId, PROVIDER, candidate.asset_key, JSON.stringify(candidate), now).run();
  }
}

async function auditHunter(env: Env, taskId: string, result: Pick<HunterRunResult, 'status' | 'retryable' | 'message' | 'candidate_count' | 'raw_keys'>): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, project_id, metadata_json, created_at)
    SELECT ?, 'system', ?, 'task', ?, t.project_id, ?, ? FROM tasks t WHERE t.id = ?
  `).bind(newId('audit'), `external_source.${PROVIDER}.${result.status}`, taskId, JSON.stringify(result), nowIso(), taskId).run();
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value ?? fallback);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function defaultPort(scheme: string, port: number): boolean {
  return (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
}

function truncate(value: string, max = 1000): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

class HunterProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}
