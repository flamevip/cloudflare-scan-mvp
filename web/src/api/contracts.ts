export type GlobalRole = 'admin' | 'reader';
export type ProjectRole = 'owner' | 'admin' | 'operator' | 'reader';
export type TokenScope = 'tasks:read' | 'tasks:write' | 'artifacts:read' | 'search:read' | 'admin:*' | '*';

export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export interface Page<T> {
  page: number;
  page_size: number;
  items: T[];
}

export interface Health {
  service: string;
  env: string;
  time: string;
}

export interface ProjectMembership {
  project_id: string;
  role: ProjectRole;
}

export interface AuthContext {
  actor_id: string;
  actor_email?: string;
  role: GlobalRole;
  token_type: 'dev_admin' | 'api_token';
  token_id?: string;
  token_scopes: string[];
  token_expires_at: string | null;
  memberships: ProjectMembership[];
  project_ids: string[];
  project_roles: Record<string, ProjectRole>;
}

export interface Project {
  id: string;
  name: string;
  scope_json: string;
  membership_role: ProjectRole;
  artifact_retention_days: number | null;
  metadata_retention_days: number | null;
  audit_retention_days: number | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  name: string;
  status: string;
  targets_json: string;
  modules_json: string;
  external_sources_json: string;
  target_count: number;
  max_agents: number;
  rate_limit: number;
  timeout_minutes: number;
  max_cost_usd?: number | null;
  asset_count?: number;
  finding_count?: number;
  artifact_count?: number;
  shards_total?: number;
  shards_success?: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  error_message?: string | null;
  deadletter_reason?: string | null;
}

export interface TaskShard {
  id: string;
  task_id: string;
  module: string;
  status: string;
  target_count: number;
  retry_count: number;
  max_retry: number;
  agent_run_id?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRun {
  id: string;
  task_id: string;
  shard_id: string;
  provider: string;
  provider_job_id?: string | null;
  provider_eip_id?: string | null;
  provider_egress_ip?: string | null;
  status: string;
  image?: string | null;
  region?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_seconds?: number | null;
  exit_code?: number | null;
  error_message?: string | null;
  provider_status?: string | null;
  provider_container_state?: string | null;
  provider_status_reason?: string | null;
  provider_status_message?: string | null;
  provider_exit_code?: number | null;
  provider_events_json?: string;
  provider_diagnostics_updated_at?: string | null;
  provider_cleanup_attempts?: number;
  provider_cleanup_last_error?: string | null;
  provider_cleanup_completed_at?: string | null;
  last_heartbeat_at?: string | null;
  timeout_at?: string | null;
  retryable?: number | boolean;
  created_at: string;
  updated_at: string;
}

export interface Asset {
  id: string;
  task_id: string;
  type: string;
  url?: string | null;
  host?: string | null;
  ip?: string | null;
  port?: number | null;
  scheme?: string | null;
  title?: string | null;
  status_code?: number | null;
  technologies_json?: string;
  created_at: string;
}

export interface Finding {
  id: string;
  task_id: string;
  asset_id?: string | null;
  asset_url?: string | null;
  asset_host?: string | null;
  severity: string;
  title: string;
  template_id?: string | null;
  matched_at?: string | null;
  metadata_json?: string;
  created_at: string;
}

export interface Artifact {
  id: string;
  task_id: string;
  shard_id?: string | null;
  agent_run_id?: string | null;
  type: string;
  raw_r2_key: string;
  search_r2_key?: string | null;
  sha256?: string | null;
  size?: number | null;
  created_at: string;
}

export interface SearchResult {
  artifact_id: string;
  task_id: string;
  type: string;
  text?: string;
  score?: number | null;
  source?: string;
  raw_r2_key?: string;
  search_r2_key?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface SearchResponse {
  degraded: boolean;
  code?: string;
  message?: string;
  query: string;
  task_id: string | null;
  type: string | null;
  items: SearchResult[];
  metadata: Record<string, unknown>;
}

export interface User {
  id: string;
  email: string;
  role: GlobalRole;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at?: string | null;
}

export interface ApiToken {
  id: string;
  user_id: string;
  email?: string;
  name: string;
  scopes_json?: string;
  scopes?: string[];
  token?: string;
  expires_at: string | null;
  revoked_at?: string | null;
  last_used_at?: string | null;
  rotated_from_token_id?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface ProjectMember {
  user_id: string;
  email: string;
  global_role: GlobalRole;
  user_status: string;
  role: ProjectRole;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  project_id?: string | null;
  metadata_json: string;
  created_at: string;
}

export interface OperationsAlert {
  code: string;
  severity: 'warning' | 'critical' | string;
  message?: string;
  count?: number;
  value?: number;
}

export interface OperationsSummary {
  generated_at: string;
  health: 'ok' | 'warning' | 'critical';
  window_hours: number;
  tasks_by_status: Array<{ status: string; count: number }>;
  tasks_last_24h_by_status: Array<{ status: string; count: number }>;
  agent_runs_last_24h_total: number;
  agent_runs_last_24h_failed_or_timeout: number;
  deadlettered_tasks: number;
  deadlettered_tasks_last_24h: number;
  stale_agent_heartbeats: number;
  overdue_task_deadlines: number;
  provider_cleanup_pending: number;
  provider_cleanup_failures: number;
  provider_cleanup_exhausted: number;
  search_documents_last_24h: number;
  alerts: OperationsAlert[];
  recent_incidents: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface CreateTaskInput {
  name?: string;
  project_id: string;
  targets: string[];
  target_urls?: string[];
  modules: string[];
  external_sources: string[];
  max_agents: number;
  rate_limit: number;
  timeout_minutes: number;
  max_cost_usd?: number;
}

export interface ProviderPreflightInput {
  provider: 'tencent_eks_ci';
  targets: string[];
  target_urls?: string[];
  modules: string[];
  rate_limit: number;
  timeout_minutes: number;
  max_cost_usd?: number | null;
  cloud_check: boolean;
}

export type ProviderPreflight = Record<string, unknown>;
