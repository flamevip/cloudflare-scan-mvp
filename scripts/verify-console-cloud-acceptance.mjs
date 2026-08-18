import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = text('.github/workflows/console-cloud-acceptance.yml');
const runner = text('scripts/run-console-cloud-acceptance.mjs');
const identities = text('scripts/manage-console-acceptance-identities.mjs');
const fixture = text('scripts/manage-console-acceptance-fixture.mjs');
const inventory = text('scripts/inspect-tencent-resource-inventory.mjs');

assert.match(workflow, /name: console-cloud-acceptance/);
assert.match(workflow, /options: \[staging, pilot\]/);
assert.match(workflow, /environment: \$\{\{ inputs\.environment \}\}/);
assert.match(workflow, /CONSOLE_ADMIN_TOKEN: \$\{\{ inputs\.environment == 'staging' && secrets\.STAGING_ADMIN_TOKEN \|\| '' \}\}/);
assert.match(workflow, /randomBytes\(32\)\.toString\('base64url'\)/);
assert.match(workflow, /::add-mask::\$\{value\}/);
assert.match(workflow, /manage-pilot-acceptance-token\.mjs create/);
assert.match(workflow, /if: always\(\) && inputs\.environment == 'pilot' && steps\.pilot_token\.outcome == 'success'/);
assert.match(workflow, /manage-console-acceptance-identities\.mjs create/);
assert.match(workflow, /if: always\(\) && steps\.identities\.outcome == 'success'/);
assert.match(workflow, /name: Create a no-cloud artifact acceptance fixture[\s\S]*manage-console-acceptance-fixture\.mjs create/);
assert.match(workflow, /name: Remove the artifact acceptance fixture[\s\S]*if: always\(\)[\s\S]*wrangler r2 object delete[\s\S]*cleanup_failed[\s\S]*manage-console-acceptance-fixture\.mjs revoke/);
assert.match(workflow, /inspect-tencent-resource-inventory\.mjs/);
assert.match(workflow, /retention-days: 30/);
assert.doesNotMatch(workflow, /wrangler deploy|TENCENT_EKS_CI_DRY_RUN = "false"|run-pilot-acceptance\.mjs run/, 'console acceptance must never deploy or enable the live Provider');

assert.match(runner, /assert\.equal\(tencent\.dry_run_enabled, true/);
assert.match(runner, /cloud_check\?\.total_count\), 0/);
assert.match(runner, /if \(environment === 'pilot'\)/);
assert.match(runner, /target\.inputValue\(\), '70yun\.xyz'/);
assert.match(runner, /rateLimit\.inputValue\(\), '1'/);
assert.match(runner, /timeout\.inputValue\(\), '15'/);
assert.match(runner, /pilot_policy_locked: true, task_submitted: false/);
assert.match(runner, /environment === 'pilot'\) violations\.push\('pilot task submission was attempted'\)/);
assert.match(runner, /request\.postDataJSON\(\)\?\.dry_run === false/);
assert.match(runner, /retention\.request\.postDataJSON\(\)\?\.dry_run, true/);
assert.match(runner, /sessionStorage\.getItem\('cloud-scan\.console\.token'\)/);
assert.match(runner, /localStorage\.getItem\('cloud-scan\.console\.token'\)/);
assert.match(runner, /request_id_displayed: true/);
assert.match(runner, /failedResponses\.find\(\(failure\) => failure\.requestId && toastText\.includes\(failure\.requestId\)\)/);
assert.match(runner, /assert\.match\(toastText, \/task not found\/i/);
assert.match(runner, /url\.origin === baseUrl\.origin && url\.pathname\.startsWith\('\/api\/'\)/);
assert.match(runner, /deepRouteResponse\?\.status\(\), 200/);
assert.match(runner, /deep_route_spa: true/);
assert.match(runner, /backend_status: result\.status, enforcement: environment === 'pilot' \? 'enforce' : 'report'/);
assert.match(runner, /fixtureTaskId = `task_console_acceptance_\$\{required\('GITHUB_RUN_ID'\)/);
assert.match(runner, /\/api\/artifacts\?task_id=\$\{encodeURIComponent\(fixtureTaskId\)\}/);
assert.doesNotMatch(runner, /tasks\.filter\(\(task\) => Number\(task\.artifact_count/, 'artifact acceptance must not depend on task-list aggregate fields');

assert.match(identities, /createHash\('sha256'\)\.update\(rawToken\)/);
assert.match(identities, /expiresAt = new Date\(Date\.now\(\) \+ 2 \* 60 \* 60_000\)/);
assert.match(identities, /UPDATE api_tokens SET revoked_at = COALESCE/);
assert.match(identities, /UPDATE project_memberships SET status = [^\n]*disabled/);
assert.doesNotMatch(identities, /console\.log\([^\n]*(rawToken|\.token)/, 'acceptance token plaintext must never be logged');

assert.match(fixture, /provider, provider_job_id, status[\s\S]*'mock_inline'/);
assert.match(fixture, /workerApi\('\/api\/agent\/ingest'/);
assert.match(fixture, /workerApi\('\/api\/agent\/complete'/);
assert.match(fixture, /DELETE FROM artifacts WHERE task_id = \?/);
assert.match(fixture, /r2_cleanup_confirmed: true/);
assert.doesNotMatch(fixture, /tencent_eks_ci|CreateEKSContainerInstances/, 'artifact fixture must not use Tencent cloud');

assert.match(inventory, /DescribeEKSContainerInstances/);
assert.match(inventory, /DescribeAddresses/);
assert.match(inventory, /assert\.equal\(inventory\.eks_instance_count, 0/);
assert.match(inventory, /assert\.equal\(inventory\.eip_count, 0/);
assert.doesNotMatch(inventory, /CreateEKS|DeleteEKS|ReleaseAddresses/, 'resource inventory must remain read-only');

console.log(JSON.stringify({ ok: true, workflow: 'console-cloud-acceptance', environments: ['staging', 'pilot'], pilot_dry_run_guarded: true, retention_execute_forbidden: true, tokens_redacted: true, tencent_inventory_readonly: true }, null, 2));

function text(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}
