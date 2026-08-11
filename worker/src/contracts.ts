export const TASK_STATUSES = ['pending', 'provisioning', 'retrying', 'running', 'completed', 'failed', 'timeout', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SHARD_STATUSES = ['provisioning', 'running', 'success', 'failed', 'timeout', 'cancelled'] as const;
export type ShardStatus = (typeof SHARD_STATUSES)[number];

export const AGENT_RUN_STATUSES = ['starting', 'running', 'success', 'failed', 'timeout', 'cancelled'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'timeout', 'cancelled'] as const satisfies readonly TaskStatus[];
export const TERMINAL_SHARD_STATUSES = ['success', 'failed', 'timeout', 'cancelled'] as const satisfies readonly ShardStatus[];
export const TERMINAL_AGENT_RUN_STATUSES = ['success', 'failed', 'timeout', 'cancelled'] as const satisfies readonly AgentRunStatus[];

export const ALLOWED_SCAN_MODULES = ['subdomain', 'http_probe', 'nuclei'] as const;
export type ScanModule = (typeof ALLOWED_SCAN_MODULES)[number];
export const DEFAULT_SCAN_MODULES = ['subdomain', 'http_probe', 'nuclei'] as const satisfies readonly ScanModule[];

export const ALLOWED_EXTERNAL_SOURCES = ['hunter'] as const;
export type ExternalSourceProvider = (typeof ALLOWED_EXTERNAL_SOURCES)[number];
export const DEFAULT_EXTERNAL_SOURCES = [] as const satisfies readonly ExternalSourceProvider[];

export const AGENT_SCAN_MODES = ['mock', 'http_probe', 'real_toolchain'] as const;
export type AgentScanMode = (typeof AGENT_SCAN_MODES)[number];
export const DEFAULT_AGENT_SCAN_MODE: AgentScanMode = 'mock';

export const DEFAULT_RATE_LIMIT = 50;
export const MIN_RATE_LIMIT = 1;
export const MAX_RATE_LIMIT = 100;
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 60;
export const DEFAULT_MAX_AGENTS = 1;
export const MIN_MAX_AGENTS = 1;
export const MAX_MAX_AGENTS = 1;

export interface AgentConfigContract {
  task_id: string;
  project_id: string;
  modules: ScanModule[];
  external_sources: ExternalSourceProvider[];
  max_agents: number;
  rate_limit: number;
  timeout_minutes: number;
  max_cost_usd: number | null;
  target_url_count?: number;
  created_at: string;
}

export function normalizeScanModules(input: unknown): ScanModule[] {
  if (input === undefined || input === null) return [...DEFAULT_SCAN_MODULES];
  if (!Array.isArray(input)) throw new Error('modules must be an array');
  if (input.length === 0) return [...DEFAULT_SCAN_MODULES];
  const modules = uniqueStrings(input, 'modules').map((module) => {
    if (!isAllowedScanModule(module)) throw new Error(`unsupported scan module: ${module}`);
    return module;
  });
  return modules;
}

export function normalizeExternalSources(input: unknown): ExternalSourceProvider[] {
  if (input === undefined || input === null) return [...DEFAULT_EXTERNAL_SOURCES];
  if (!Array.isArray(input)) throw new Error('external_sources must be an array');
  const providers = uniqueStrings(input, 'external_sources').map((provider) => {
    if (!isAllowedExternalSourceProvider(provider)) throw new Error(`unsupported external source provider: ${provider}`);
    return provider;
  });
  return providers;
}

export function isAllowedScanModule(value: string): value is ScanModule {
  return (ALLOWED_SCAN_MODULES as readonly string[]).includes(value);
}

export function isAllowedExternalSourceProvider(value: string): value is ExternalSourceProvider {
  return (ALLOWED_EXTERNAL_SOURCES as readonly string[]).includes(value);
}

export function isAgentScanMode(value: string): value is AgentScanMode {
  return (AGENT_SCAN_MODES as readonly string[]).includes(value);
}

function uniqueStrings(input: unknown[], field: string): string[] {
  const values = input.map((item) => String(item ?? '').trim().toLowerCase());
  if (values.some((value) => !value)) throw new Error(`${field} cannot contain empty values`);
  return [...new Set(values)];
}
