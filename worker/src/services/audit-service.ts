import type { Env } from '../env';
import { newId, nowIso } from '../ids';

export interface AuditEvent {
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  project_id?: string | null;
  metadata?: Record<string, unknown>;
}

export async function writeAudit(env: Env, event: AuditEvent): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, project_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId('audit'),
    event.actor,
    event.action,
    event.entity_type,
    event.entity_id,
    event.project_id ?? null,
    JSON.stringify(event.metadata ?? {}),
    nowIso(),
  ).run();
}
