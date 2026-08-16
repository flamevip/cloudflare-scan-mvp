export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date) : value;
}

export function formatDuration(seconds?: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function formatBytes(value?: number | null): string {
  if (value === null || value === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let number = value;
  let unit = 0;
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit += 1; }
  return `${number.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function shortId(value?: string | null, head = 8): string {
  if (!value) return '—';
  return value.length > head + 5 ? `${value.slice(0, head)}…${value.slice(-4)}` : value;
}

export function statusTone(status?: string | null): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  const normalized = (status || '').toLowerCase();
  if (['completed', 'success', 'active', 'ok', 'healthy'].includes(normalized)) return 'success';
  if (['failed', 'timeout', 'critical', 'disabled', 'revoked', 'cancelled'].includes(normalized)) return 'danger';
  if (['pending', 'running', 'retrying', 'provisioning', 'starting', 'warning', 'queued'].includes(normalized)) return 'warning';
  if (['reader', 'operator', 'admin', 'owner'].includes(normalized)) return 'info';
  return 'neutral';
}
