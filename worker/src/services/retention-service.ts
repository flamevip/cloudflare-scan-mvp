import type { Env } from '../env';
import { nowIso } from '../ids';
import { taskPrefix } from './r2-service';
import { retentionDefaults } from './project-admin-service';
import { writeAudit } from './audit-service';

const ARTIFACT_BATCH = 100;
const TASK_BATCH = 25;
const AUDIT_BATCH = 500;

interface ExpiredArtifactRow {
  id: string;
  task_id: string;
  project_id: string;
  raw_r2_key: string;
  search_r2_key: string | null;
}

interface ExpiredTaskRow {
  id: string;
  project_id: string;
}

interface ProjectRetentionRow {
  id: string;
  audit_retention_days: number | null;
}

export interface RetentionSweepResult {
  dry_run: boolean;
  artifacts_checked: number;
  artifacts_deleted: number;
  artifact_delete_failures: number;
  tasks_checked: number;
  tasks_deleted: number;
  task_delete_failures: number;
  audit_logs_deleted: number;
}

export async function sweepRetention(env: Env, options: { dry_run?: boolean; now?: string } = {}): Promise<RetentionSweepResult> {
  const dryRun = Boolean(options.dry_run);
  const observedAt = options.now ?? nowIso();
  const defaults = retentionDefaults(env);
  const result: RetentionSweepResult = {
    dry_run: dryRun,
    artifacts_checked: 0,
    artifacts_deleted: 0,
    artifact_delete_failures: 0,
    tasks_checked: 0,
    tasks_deleted: 0,
    task_delete_failures: 0,
    audit_logs_deleted: 0,
  };

  const artifacts = await env.DB.prepare(`
    SELECT ar.id, ar.task_id, t.project_id, ar.raw_r2_key, ar.search_r2_key
    FROM artifacts ar
      INNER JOIN tasks t ON t.id = ar.task_id
      INNER JOIN projects p ON p.id = t.project_id
    WHERE julianday(ar.created_at) < julianday(?) - COALESCE(p.artifact_retention_days, ?)
    ORDER BY ar.created_at ASC LIMIT ?
  `).bind(observedAt, defaults.artifact, ARTIFACT_BATCH).all<ExpiredArtifactRow>();
  result.artifacts_checked = artifacts.results.length;
  for (const artifact of artifacts.results) {
    if (dryRun) continue;
    try {
      const keys = [artifact.raw_r2_key, artifact.search_r2_key].filter((key): key is string => Boolean(key));
      if (keys.length) await env.ARTIFACTS.delete(keys);
      await env.DB.prepare('DELETE FROM artifacts WHERE id = ?').bind(artifact.id).run();
      result.artifacts_deleted += 1;
    } catch (error) {
      result.artifact_delete_failures += 1;
      console.error(JSON.stringify({ event: 'retention.artifact.failed', artifact_id: artifact.id, task_id: artifact.task_id, error: safeMessage(error) }));
    }
  }

  const tasks = await env.DB.prepare(`
    SELECT t.id, t.project_id
    FROM tasks t INNER JOIN projects p ON p.id = t.project_id
    WHERE t.status IN ('completed', 'failed', 'timeout', 'cancelled')
      AND t.finished_at IS NOT NULL
      AND julianday(t.finished_at) < julianday(?) - COALESCE(p.metadata_retention_days, ?)
      AND NOT EXISTS (SELECT 1 FROM artifacts ar WHERE ar.task_id = t.id)
    ORDER BY t.finished_at ASC LIMIT ?
  `).bind(observedAt, defaults.metadata, TASK_BATCH).all<ExpiredTaskRow>();
  result.tasks_checked = tasks.results.length;
  for (const task of tasks.results) {
    if (dryRun) continue;
    try {
      await deleteR2Prefix(env, `${taskPrefix(task.id)}/`);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM external_source_results WHERE task_id = ?').bind(task.id),
        env.DB.prepare('DELETE FROM findings WHERE task_id = ?').bind(task.id),
        env.DB.prepare('DELETE FROM assets WHERE task_id = ?').bind(task.id),
        env.DB.prepare('DELETE FROM agent_runs WHERE task_id = ?').bind(task.id),
        env.DB.prepare('DELETE FROM task_shards WHERE task_id = ?').bind(task.id),
        env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(task.id),
      ]);
      result.tasks_deleted += 1;
    } catch (error) {
      result.task_delete_failures += 1;
      console.error(JSON.stringify({ event: 'retention.task.failed', task_id: task.id, error: safeMessage(error) }));
    }
  }

  const projects = await env.DB.prepare('SELECT id, audit_retention_days FROM projects ORDER BY id').all<ProjectRetentionRow>();
  for (const project of projects.results) {
    const days = project.audit_retention_days ?? defaults.audit;
    result.audit_logs_deleted += await purgeAuditBatch(env, observedAt, days, project.id, dryRun);
  }
  result.audit_logs_deleted += await purgeAuditBatch(env, observedAt, defaults.audit, null, dryRun);
  result.audit_logs_deleted += await purgeOrphanProjectAuditBatch(env, observedAt, defaults.audit, dryRun);

  if (!dryRun) {
    await writeAudit(env, { actor: 'system', action: 'retention.sweep', entity_type: 'system', entity_id: 'retention', metadata: { ...result } });
  }
  return result;
}

async function purgeOrphanProjectAuditBatch(env: Env, observedAt: string, days: number, dryRun: boolean): Promise<number> {
  const rows = await env.DB.prepare(`
    SELECT id FROM audit_logs
    WHERE project_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM projects WHERE id = audit_logs.project_id)
      AND julianday(created_at) < julianday(?) - ?
    ORDER BY created_at ASC LIMIT ?
  `).bind(observedAt, days, AUDIT_BATCH).all<{ id: string }>();
  if (!dryRun && rows.results.length) {
    await env.DB.batch(rows.results.map((row) => env.DB.prepare('DELETE FROM audit_logs WHERE id = ?').bind(row.id)));
  }
  return rows.results.length;
}

async function purgeAuditBatch(env: Env, observedAt: string, days: number, projectId: string | null, dryRun: boolean): Promise<number> {
  const rows = projectId
    ? await env.DB.prepare(`SELECT id FROM audit_logs WHERE project_id = ? AND julianday(created_at) < julianday(?) - ? ORDER BY created_at ASC LIMIT ?`).bind(projectId, observedAt, days, AUDIT_BATCH).all<{ id: string }>()
    : await env.DB.prepare(`SELECT id FROM audit_logs WHERE project_id IS NULL AND julianday(created_at) < julianday(?) - ? ORDER BY created_at ASC LIMIT ?`).bind(observedAt, days, AUDIT_BATCH).all<{ id: string }>();
  if (!dryRun && rows.results.length) {
    await env.DB.batch(rows.results.map((row) => env.DB.prepare('DELETE FROM audit_logs WHERE id = ?').bind(row.id)));
  }
  return rows.results.length;
}

async function deleteR2Prefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.ARTIFACTS.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length) await env.ARTIFACTS.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(token|secret|password)=([^\s&]+)/gi, '$1=[redacted]').slice(0, 240);
}
