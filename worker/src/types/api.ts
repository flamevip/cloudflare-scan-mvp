export interface CreateTaskRequest {
  name?: string;
  project_id?: string;
  targets: string[];
  target_urls?: string[];
  modules?: string[];
  external_sources?: string[];
  max_agents?: number;
  rate_limit?: number;
  timeout_minutes?: number;
  max_cost_usd?: number;
}

export interface AgentIdentity {
  task_id: string;
  shard_id: string;
  agent_run_id: string;
  exp: number;
}

export interface IngestPayload {
  task_id: string;
  shard_id: string;
  agent_run_id: string;
  assets?: Array<Record<string, unknown>>;
  findings?: Array<Record<string, unknown>>;
  artifacts?: Array<Record<string, unknown>>;
}
