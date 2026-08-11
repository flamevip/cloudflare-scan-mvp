-- Initial MVP metadata schema. D1 stores lightweight metadata only; raw artifacts live in R2.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  modules_json TEXT NOT NULL,
  external_sources_json TEXT NOT NULL DEFAULT '[]',
  target_count INTEGER NOT NULL DEFAULT 0,
  max_agents INTEGER NOT NULL DEFAULT 1,
  rate_limit INTEGER NOT NULL DEFAULT 50,
  timeout_minutes INTEGER NOT NULL DEFAULT 30,
  created_by TEXT NOT NULL,
  config_r2_key TEXT,
  targets_r2_key TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_shards (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  module TEXT NOT NULL,
  status TEXT NOT NULL,
  targets_r2_key TEXT,
  config_r2_key TEXT,
  target_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retry INTEGER NOT NULL DEFAULT 0,
  agent_run_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_job_id TEXT,
  status TEXT NOT NULL,
  image TEXT,
  region TEXT,
  callback_token TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_seconds INTEGER,
  exit_code INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  asset_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  url TEXT,
  host TEXT,
  ip TEXT,
  port INTEGER,
  scheme TEXT,
  title TEXT,
  status_code INTEGER,
  technologies_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  asset_id TEXT,
  unique_key TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  template_id TEXT,
  matched_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  shard_id TEXT,
  agent_run_id TEXT,
  type TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  search_r2_key TEXT,
  sha256 TEXT,
  size INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_source_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  asset_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(task_id, provider, asset_key)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
