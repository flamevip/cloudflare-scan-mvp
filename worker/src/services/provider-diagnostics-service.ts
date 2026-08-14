import type { Env } from '../env';
import { nowIso } from '../ids';
import {
  describeTencentEksContainerInstanceEvents,
  describeTencentEksContainerInstances,
  type TencentContainerState,
  type TencentEksCiEvent,
} from './tencent-eks-ci-service';
import { normalizePublicIpv4 } from './provider-egress-service';
import { toProviderLaunchError } from './provider-errors';

const DIAGNOSTICS_BATCH_SIZE = 20;
const MAX_EVENTS = 20;
const MAX_STATUS_LENGTH = 80;
const MAX_REASON_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 600;

export interface ProviderDiagnosticsRunRow {
  id: string;
  task_id: string;
  provider: string;
  provider_job_id: string | null;
}

export interface ProviderDiagnosticsResult {
  attempted: boolean;
  persisted: boolean;
  partial: boolean;
  errors: string[];
}

export interface ProviderDiagnosticsSweepResult {
  checked: number;
  persisted: number;
  partial: number;
  failed: number;
}

export async function collectProviderDiagnostics(env: Env, run: ProviderDiagnosticsRunRow): Promise<ProviderDiagnosticsResult> {
  if (run.provider !== 'tencent_eks_ci' || !isRealTencentEksCiId(run.provider_job_id)) {
    return { attempted: false, persisted: false, partial: false, errors: [] };
  }

  const providerJobId = run.provider_job_id;
  const [describe, events] = await Promise.allSettled([
    describeTencentEksContainerInstances(env, { ids: [providerJobId], limit: 1 }),
    describeTencentEksContainerInstanceEvents(env, providerJobId, MAX_EVENTS),
  ]);
  const errors: string[] = [];
  let status: string | null = null;
  let state: TencentContainerState | null = null;
  let eventsJson: string | null = null;
  let providerEipId: string | null = null;
  let providerEgressIp: string | null = null;

  if (describe.status === 'fulfilled') {
    const instance = describe.value.instances.find((candidate) => candidate.EksCiId === providerJobId) ?? null;
    status = sanitizeDiagnosticText(instance?.Status ?? (describe.value.total_count === 0 ? 'absent' : 'unknown'), MAX_STATUS_LENGTH);
    state = instance?.Containers?.map((container) => container.CurrentState).find((candidate): candidate is TencentContainerState => Boolean(candidate)) ?? null;
    providerEipId = normalizeTencentEipId(instance?.AutoCreatedEipId);
    providerEgressIp = typeof instance?.EipAddress === 'string' ? normalizePublicIpv4(instance.EipAddress) : null;
  } else {
    errors.push(toProviderLaunchError(describe.reason, 'tencent_eks_ci').safe_message);
  }

  if (events.status === 'fulfilled') {
    eventsJson = JSON.stringify(events.value.events.slice(0, MAX_EVENTS).map(sanitizeEvent));
  } else {
    errors.push(toProviderLaunchError(events.reason, 'tencent_eks_ci').safe_message);
  }

  if (describe.status === 'rejected' && events.status === 'rejected') {
    logDiagnostics('provider.diagnostics.failed', run, errors);
    return { attempted: true, persisted: false, partial: false, errors };
  }

  const now = nowIso();
  try {
    await env.DB.prepare(`
      UPDATE agent_runs
      SET provider_eip_id = COALESCE(provider_eip_id, ?),
          provider_egress_ip = COALESCE(provider_egress_ip, ?),
          provider_status = COALESCE(?, provider_status),
          provider_container_state = COALESCE(?, provider_container_state),
          provider_status_reason = COALESCE(?, provider_status_reason),
          provider_status_message = COALESCE(?, provider_status_message),
          provider_exit_code = COALESCE(?, provider_exit_code),
          provider_events_json = CASE WHEN ? IS NULL THEN provider_events_json ELSE ? END,
          provider_diagnostics_updated_at = ?, updated_at = ?
      WHERE id = ? AND task_id = ? AND provider = 'tencent_eks_ci' AND provider_job_id = ?
    `).bind(
      providerEipId,
      providerEgressIp,
      status,
      sanitizeDiagnosticText(state?.State, MAX_STATUS_LENGTH),
      sanitizeDiagnosticText(state?.Reason, MAX_REASON_LENGTH),
      sanitizeDiagnosticText(state?.Message, MAX_MESSAGE_LENGTH),
      normalizeExitCode(state?.ExitCode),
      eventsJson,
      eventsJson,
      now,
      now,
      run.id,
      run.task_id,
      providerJobId,
    ).run();
  } catch (error) {
    errors.push(safeDiagnosticsError(error));
    logDiagnostics('provider.diagnostics.persist_failed', run, errors);
    return { attempted: true, persisted: false, partial: describe.status === 'fulfilled' || events.status === 'fulfilled', errors };
  }

  logDiagnostics('provider.diagnostics.collected', run, errors);
  return { attempted: true, persisted: true, partial: errors.length > 0, errors };
}

export async function sweepProviderDiagnostics(env: Env): Promise<ProviderDiagnosticsSweepResult> {
  const rows = await env.DB.prepare(`
    SELECT id, task_id, provider, provider_job_id
    FROM agent_runs
    WHERE provider = 'tencent_eks_ci'
      AND status IN ('starting', 'running')
      AND provider_job_id LIKE 'eksci-%'
    ORDER BY COALESCE(provider_diagnostics_updated_at, created_at) ASC
    LIMIT ?
  `).bind(DIAGNOSTICS_BATCH_SIZE).all<ProviderDiagnosticsRunRow>();
  const summary: ProviderDiagnosticsSweepResult = { checked: rows.results.length, persisted: 0, partial: 0, failed: 0 };
  for (const row of rows.results) {
    const result = await collectProviderDiagnostics(env, row);
    if (result.persisted) summary.persisted += 1;
    else summary.failed += 1;
    if (result.partial) summary.partial += 1;
  }
  return summary;
}

export function sanitizeDiagnosticText(value: unknown, maxLength = MAX_MESSAGE_LENGTH): string | null {
  if (value === null || value === undefined) return null;
  const redacted = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\bAKID[A-Za-z0-9]+\b/g, '[redacted-secret-id]')
    .replace(/\b(callback[_-]?token|authorization|password|secret(?:[_-]?(?:id|key))?|token)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted ? redacted.slice(0, Math.max(1, maxLength)) : null;
}

function sanitizeEvent(event: TencentEksCiEvent): Record<string, unknown> {
  return {
    pod_name: sanitizeDiagnosticText(event.PodName, 120),
    reason: sanitizeDiagnosticText(event.Reason, MAX_REASON_LENGTH),
    type: sanitizeDiagnosticText(event.Type, 40),
    count: normalizeCount(event.Count),
    first_timestamp: sanitizeTimestamp(event.FirstTimestamp),
    last_timestamp: sanitizeTimestamp(event.LastTimestamp),
    message: sanitizeDiagnosticText(event.Message, MAX_MESSAGE_LENGTH),
  };
}

function isRealTencentEksCiId(value: string | null): value is string {
  return Boolean(value && /^eksci-[A-Za-z0-9-]+$/.test(value));
}

function normalizeTencentEipId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return /^eip-[A-Za-z0-9-]{1,64}$/.test(candidate) ? candidate : null;
}

function normalizeExitCode(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= -1 && number <= 65535 ? number : null;
}

function normalizeCount(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? Math.min(number, 1_000_000) : null;
}

function sanitizeTimestamp(value: unknown): string | null {
  const text = sanitizeDiagnosticText(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function safeDiagnosticsError(error: unknown): string {
  return sanitizeDiagnosticText(error instanceof Error ? error.message : error, 240) ?? 'provider diagnostics persistence failed';
}

function logDiagnostics(event: string, run: ProviderDiagnosticsRunRow, errors: string[]): void {
  const payload = JSON.stringify({ event, task_id: run.task_id, agent_run_id: run.id, provider: run.provider, provider_job_id: run.provider_job_id, partial: errors.length > 0, errors });
  if (event.endsWith('failed')) console.error(payload);
  else console.log(payload);
}
