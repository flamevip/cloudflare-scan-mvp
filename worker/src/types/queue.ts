export interface TaskCreatedMessage {
  type: 'task.created';
  task_id: string;
  project_id: string;
  config_r2_key: string;
  targets_r2_key: string;
  attempt: number;
  created_at: string;
  required_provider_mode?: 'dry_run' | 'live';
}

export interface DeploymentCanaryMessage {
  type: 'deployment.canary';
  nonce: string;
  created_at: string;
}

export interface ProviderCleanupMessage {
  type: 'provider.cleanup';
  task_id: string;
  agent_run_id: string;
  attempt: number;
  created_at: string;
}

export type ScanDispatchMessage = TaskCreatedMessage | DeploymentCanaryMessage | ProviderCleanupMessage;
