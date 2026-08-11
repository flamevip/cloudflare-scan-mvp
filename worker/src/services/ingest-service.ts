import type { Env } from '../env';
import type { IngestPayload } from '../types/api';
import { newId, nowIso } from '../ids';
import { putText, taskPrefix } from './r2-service';
import { assertAssetInScope } from './scope-validation';
import { HttpError } from '../response';

interface TaskRow {
  id: string;
  targets_json: string;
}

export async function ingestAgentPayload(env: Env, payload: IngestPayload): Promise<{ assets: number; findings: number; artifacts: number }> {
  const task = await env.DB.prepare('SELECT id, targets_json FROM tasks WHERE id = ?').bind(payload.task_id).first<TaskRow>();
  if (!task) throw new Error(`task not found: ${payload.task_id}`);
  await assertIngestActive(env, payload.task_id, payload.shard_id, payload.agent_run_id);
  const targets = JSON.parse(task.targets_json) as string[];
  let assetCount = 0;
  let findingCount = 0;
  let artifactCount = 0;
  const now = nowIso();

  for (const asset of payload.assets ?? []) {
    const url = String(asset.url ?? '');
    const host = String(asset.host ?? (url ? new URL(url).hostname : ''));
    assertAssetInScope(host || url, targets);
    const scheme = String(asset.scheme ?? (url.startsWith('http://') ? 'http' : 'https'));
    const port = Number(asset.port ?? (scheme === 'http' ? 80 : 443));
    const assetKey = withTaskPrefix(payload.task_id, String(asset.asset_key ?? `${scheme}:${host}:${port}:${url || '/'}`));
    const id = newId('asset');
    const inserted = await env.DB.prepare(`
      INSERT INTO assets (id, task_id, asset_key, type, url, host, ip, port, scheme, title, status_code, technologies_json, created_at, updated_at)
      SELECT ?, ?, ?, 'http', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM agent_runs ar INNER JOIN tasks t ON t.id = ar.task_id
        WHERE ar.id = ? AND ar.task_id = ? AND ar.shard_id = ?
          AND ar.status IN ('starting', 'running')
          AND t.id = ? AND t.status NOT IN ('completed', 'failed', 'timeout', 'cancelled')
      )
      ON CONFLICT(asset_key) DO UPDATE SET
        url = excluded.url,
        host = excluded.host,
        ip = excluded.ip,
        port = excluded.port,
        scheme = excluded.scheme,
        title = excluded.title,
        status_code = excluded.status_code,
        technologies_json = excluded.technologies_json,
        updated_at = excluded.updated_at
    `).bind(
      id,
      payload.task_id,
      assetKey,
      url || null,
      host || null,
      asset.ip ? String(asset.ip) : null,
      port,
      scheme,
      asset.title ? String(asset.title) : null,
      asset.status_code ? Number(asset.status_code) : null,
      JSON.stringify(asset.technologies ?? []),
      now,
      now,
      payload.agent_run_id,
      payload.task_id,
      payload.shard_id,
      payload.task_id,
    ).run();
    if (!changed(inserted)) throw new HttpError(409, 'agent run became terminal during ingest');
    assetCount++;
  }

  for (const finding of payload.findings ?? []) {
    const sourceAssetKey = withTaskPrefix(payload.task_id, String(finding.asset_key ?? 'unknown'));
    const asset = await env.DB.prepare('SELECT id FROM assets WHERE asset_key = ?').bind(sourceAssetKey).first<{ id: string }>();
    const uniqueKey = withTaskPrefix(payload.task_id, String(finding.unique_key ?? `${sourceAssetKey}:${finding.template_id ?? finding.title ?? 'finding'}`));
    const id = newId('finding');
    const inserted = await env.DB.prepare(`
      INSERT INTO findings (id, task_id, asset_id, unique_key, severity, title, template_id, matched_at, metadata_json, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM agent_runs ar INNER JOIN tasks t ON t.id = ar.task_id
        WHERE ar.id = ? AND ar.task_id = ? AND ar.shard_id = ?
          AND ar.status IN ('starting', 'running')
          AND t.id = ? AND t.status NOT IN ('completed', 'failed', 'timeout', 'cancelled')
      )
      ON CONFLICT(unique_key) DO UPDATE SET
        severity = excluded.severity,
        title = excluded.title,
        template_id = excluded.template_id,
        matched_at = excluded.matched_at,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).bind(
      id,
      payload.task_id,
      asset?.id ?? null,
      uniqueKey,
      String(finding.severity ?? 'info'),
      String(finding.title ?? 'Untitled finding'),
      finding.template_id ? String(finding.template_id) : null,
      finding.matched_at ? String(finding.matched_at) : null,
      JSON.stringify(finding),
      now,
      now,
      payload.agent_run_id,
      payload.task_id,
      payload.shard_id,
      payload.task_id,
    ).run();
    if (!changed(inserted)) throw new HttpError(409, 'agent run became terminal during ingest');
    findingCount++;
  }

  for (const artifact of payload.artifacts ?? []) {
    const id = newId('artifact');
    const type = String(artifact.type ?? 'raw');
    const rawKey = String(artifact.raw_r2_key ?? `${taskPrefix(payload.task_id)}/raw/mock/${payload.shard_id}-${id}.jsonl`);
    const searchKey = artifact.search_r2_key
      ? String(artifact.search_r2_key)
      : artifact.search_content !== undefined
        ? `${taskPrefix(payload.task_id)}/search/mock/${payload.shard_id}-${id}.md`
        : null;
    assertTaskR2Key(payload.task_id, rawKey);
    if (searchKey) assertTaskR2Key(payload.task_id, searchKey);
    const writtenKeys: string[] = [];
    if (artifact.raw_content !== undefined) {
      await putText(env, rawKey, String(artifact.raw_content), 'application/jsonl; charset=utf-8');
      writtenKeys.push(rawKey);
    }
    if (searchKey && artifact.search_content !== undefined) {
      await putText(env, searchKey, String(artifact.search_content), 'text/markdown; charset=utf-8', {
        task_id: payload.task_id,
        shard_id: payload.shard_id,
        agent_run_id: payload.agent_run_id,
        artifact_type: type,
        search_doc: 'true',
      });
      writtenKeys.push(searchKey);
    }
    const inserted = await env.DB.prepare(`
      INSERT INTO artifacts (id, task_id, shard_id, agent_run_id, type, raw_r2_key, search_r2_key, sha256, size, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM agent_runs ar INNER JOIN tasks t ON t.id = ar.task_id
        WHERE ar.id = ? AND ar.task_id = ? AND ar.shard_id = ?
          AND ar.status IN ('starting', 'running')
          AND t.id = ? AND t.status NOT IN ('completed', 'failed', 'timeout', 'cancelled')
      )
    `).bind(
      id,
      payload.task_id,
      payload.shard_id,
      payload.agent_run_id,
      type,
      rawKey,
      searchKey,
      artifact.sha256 ? String(artifact.sha256) : null,
      artifact.size ? Number(artifact.size) : null,
      now,
      payload.agent_run_id,
      payload.task_id,
      payload.shard_id,
      payload.task_id,
    ).run();
    if (!changed(inserted)) {
      if (writtenKeys.length) {
        try {
          await env.ARTIFACTS.delete(writtenKeys);
        } catch (error) {
          console.error(JSON.stringify({ event: 'ingest.orphan_cleanup.failed', task_id: payload.task_id, agent_run_id: payload.agent_run_id, keys: writtenKeys, error: error instanceof Error ? error.message : String(error) }));
        }
      }
      throw new HttpError(409, 'agent run became terminal during ingest');
    }
    artifactCount++;
  }

  return { assets: assetCount, findings: findingCount, artifacts: artifactCount };
}

async function assertIngestActive(env: Env, taskId: string, shardId: string, agentRunId: string): Promise<void> {
  const row = await env.DB.prepare(`
    SELECT ar.status AS run_status, t.status AS task_status
    FROM agent_runs ar INNER JOIN tasks t ON t.id = ar.task_id
    WHERE ar.id = ? AND ar.task_id = ? AND ar.shard_id = ?
  `).bind(agentRunId, taskId, shardId).first<{ run_status: string; task_status: string }>();
  if (!row || !['starting', 'running'].includes(row.run_status) || ['completed', 'failed', 'timeout', 'cancelled'].includes(row.task_status)) {
    throw new HttpError(409, 'agent run is terminal or superseded');
  }
}

function assertTaskR2Key(taskId: string, key: string): void {
  if (!key.startsWith(`${taskPrefix(taskId)}/`)) throw new HttpError(400, 'artifact R2 key must remain inside the task prefix');
}

function changed(result: D1Result | undefined): boolean {
  return Number(result?.meta?.changes ?? 0) > 0;
}

function withTaskPrefix(taskId: string, key: string): string {
  return key.startsWith(`${taskId}:`) ? key : `${taskId}:${key}`;
}
