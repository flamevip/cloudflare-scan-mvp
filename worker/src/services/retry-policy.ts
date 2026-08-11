export const DEFAULT_MAX_RETRY = 1;
export const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 600;

export interface RetryDecisionInput {
  attempt: number;
  maxRetry: number;
  retryable: boolean;
}

export interface RetryDecision {
  action: 'retry' | 'deadletter';
  next_attempt: number | null;
  reason: string;
}

export interface TimeoutDecisionInput {
  status: string;
  lastHeartbeatAt?: string | null;
  startedAt?: string | null;
  createdAt: string;
  now: string;
  timeoutSeconds: number;
}

export interface TimeoutDecision {
  timed_out: boolean;
  age_seconds: number;
  reason: string;
}

export const STATE_TRANSITIONS = [
  'pending -> provisioning -> running -> completed',
  'provisioning launch failure -> retrying -> provisioning (bounded by max_retry)',
  'provisioning launch failure -> failed + deadletter when attempts exhausted',
  'starting/running heartbeat stale -> retrying when attempts remain',
  'starting/running heartbeat stale -> timeout + deadletter when attempts exhausted',
  'agent fail callback -> failed terminal',
  'duplicate queue delivery -> no-op when active shard exists',
  'duplicate complete callback -> idempotent terminal update',
] as const;

export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const attempt = Math.max(1, Math.floor(input.attempt || 1));
  const maxRetry = Math.max(0, Math.floor(input.maxRetry || 0));
  if (!input.retryable) return { action: 'deadletter', next_attempt: null, reason: 'failure is not retryable' };
  if (attempt <= maxRetry) return { action: 'retry', next_attempt: attempt + 1, reason: `attempt ${attempt} of ${maxRetry + 1}` };
  return { action: 'deadletter', next_attempt: null, reason: `attempt ${attempt} exhausted max_retry ${maxRetry}` };
}

export function decideTimeout(input: TimeoutDecisionInput): TimeoutDecision {
  if (!['starting', 'running'].includes(input.status)) return { timed_out: false, age_seconds: 0, reason: `status ${input.status} is not timeout-eligible` };
  const observedAt = input.lastHeartbeatAt || input.startedAt || input.createdAt;
  const ageSeconds = Math.max(0, Math.floor((Date.parse(input.now) - Date.parse(observedAt)) / 1000));
  if (!Number.isFinite(ageSeconds)) return { timed_out: false, age_seconds: 0, reason: 'invalid timestamp' };
  if (ageSeconds > input.timeoutSeconds) return { timed_out: true, age_seconds: ageSeconds, reason: `stale heartbeat age ${ageSeconds}s > ${input.timeoutSeconds}s` };
  return { timed_out: false, age_seconds: ageSeconds, reason: `heartbeat age ${ageSeconds}s within ${input.timeoutSeconds}s` };
}

export function parseMaxRetry(value: unknown): number {
  return clampNumber(value, DEFAULT_MAX_RETRY, 0, 5);
}

export function parseHeartbeatTimeoutSeconds(value: unknown): number {
  return clampNumber(value, DEFAULT_HEARTBEAT_TIMEOUT_SECONDS, 60, 24 * 60 * 60);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value ?? fallback);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}
