import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const reportPath = process.env.ACCEPTANCE_REPORT_PATH ?? 'work/staging-mock-acceptance.json';
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const diagnostics = report.provider_diagnostics ?? {};
const diagnosticText = JSON.stringify(diagnostics);

assert.match(report.provider_job_id ?? '', /^eksci-/, 'real Tencent diagnostic instance ID was not recorded');
assert.equal(diagnostics.status, 'Running', `diagnostic instance did not reach Running: ${diagnostics.status ?? 'unknown'}`);
assert.doesNotMatch(diagnosticText, /ErrImagePull|ImagePullBackOff|Failed to pull|DeadlineExceeded/i, 'domestic registry image pull failed');
assert.equal(report.heartbeat_observed, false, 'pause diagnostic image unexpectedly called the Agent API');
assert.equal(Number(report.artifact_count ?? -1), 0, 'pause diagnostic image unexpectedly produced artifacts');
assert.equal(report.cleanup_completed, true, 'diagnostic instance cleanup did not complete');
assert.equal(Number(report.tencent_instance_count_after ?? -1), 0, 'Tencent diagnostic instance remains after cleanup');

console.log(JSON.stringify({
  ok: true,
  provider_job_id: report.provider_job_id,
  provider_status: diagnostics.status,
  provider_container_state: diagnostics.container_state ?? null,
  provider_eip_id: report.provider_eip_id || null,
  provider_egress_ip: report.provider_egress_ip ?? null,
  image_pull_errors: false,
  cleanup_completed: true,
  tencent_instance_count_after: 0,
}));
