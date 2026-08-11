export interface ScanDispatchMessage {
  type: 'task.created';
  task_id: string;
  project_id: string;
  config_r2_key: string;
  targets_r2_key: string;
  attempt: number;
  created_at: string;
}
