import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const main = text('infra/tencent/main.tf');
const versions = text('infra/tencent/versions.tf');
const bootstrap = [text('infra/tencent/bootstrap/main.tf'), text('infra/tencent/bootstrap/versions.tf')].join('\n');
const ci = text('.github/workflows/ci.yml');
const infraWorkflow = text('.github/workflows/tencent-infra.yml');
const stagingAcceptanceWorkflow = text('.github/workflows/staging-mock-acceptance.yml');
const stagingDryrunPreflightWorkflow = text('.github/workflows/staging-dryrun-preflight.yml');
const stagingNegativeAcceptanceWorkflow = text('.github/workflows/staging-negative-acceptance.yml');
const stagingRegistryDiagnosticWorkflow = text('.github/workflows/staging-registry-connectivity.yml');
const stagingAcceptanceScript = text('scripts/run-staging-mock-acceptance.mjs');
const stagingRegistryDiagnosticScript = text('scripts/assert-staging-registry-connectivity.mjs');
const pilotAcceptanceWorkflow = text('.github/workflows/pilot-acceptance.yml');
const pilotAcceptanceScript = text('scripts/run-pilot-acceptance.mjs');
const pilotTokenScript = text('scripts/manage-pilot-acceptance-token.mjs');
const providerCleanupService = text('worker/src/services/provider-cleanup-service.ts');
const tencentEksCiService = text('worker/src/services/tencent-eks-ci-service.ts');
const tencentVpcService = text('worker/src/services/tencent-vpc-service.ts');
const staging = text('config/staging.env.example');
const pilot = text('config/pilot.env.example');

for (const [name, workflow] of [
  ['staging-real-mock-acceptance', stagingAcceptanceWorkflow],
  ['staging-negative-acceptance', stagingNegativeAcceptanceWorkflow],
  ['staging-domestic-registry-connectivity', stagingRegistryDiagnosticWorkflow],
  ['pilot-live-acceptance', pilotAcceptanceWorkflow],
]) {
  assert.match(workflow, /npm run build:web/, `${name} must build web/dist before deploying Worker static assets`);
}

for (const resource of ['tencentcloud_vpc', 'tencentcloud_subnet', 'tencentcloud_security_group', 'tencentcloud_security_group_rule_set', 'tencentcloud_cam_policy', 'tencentcloud_cam_user_policy_attachment']) {
  assert.match(main, new RegExp(`resource "${resource}"`), `missing ${resource}`);
}
assert.match(main, /environments = toset\(\["staging", "pilot"\]\)/);
for (const cidr of ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16']) assert.match(main, new RegExp(escapeRegExp(cidr)));
assert.ok(main.indexOf('dynamic "egress"') < main.indexOf('Allow public DNS'), 'deny egress rules must precede public allow');
for (const sharedEgressResource of ['tencentcloud_eip', 'tencentcloud_nat_gateway', 'tencentcloud_route_table_entry']) {
  assert.doesNotMatch(main, new RegExp(`resource "${sharedEgressResource}"`), `shared egress resource ${sharedEgressResource} must not exist`);
}
assert.doesNotMatch(main, /tencentcloud_tcr_|open_public_operation/, 'Terraform must not manage TCR');
for (const action of ['tke:CreateEKSContainerInstances', 'tke:DescribeEKSContainerInstanceEvent', 'tke:DescribeEKSContainerInstances', 'tke:DeleteEKSContainerInstances', 'cvm:DescribeAddresses', 'cvm:ReleaseAddresses']) assert.match(main, new RegExp(action));
assert.doesNotMatch(main, /vpc:(Describe|Release)Addresses/, 'Tencent CAM authorizes EIP actions with the legacy cvm prefix even though calls use the VPC endpoint');
assert.match(providerCleanupService, /cleanupTencentEksAutoCreatedEip/, 'provider cleanup must verify and release the per-run Tencent EIP');
assert.match(providerCleanupService, /provider deletion will retry before releasing cloud resources/, 'cleanup must retain the EKS instance until an exact EIP hint is recorded');
assert.match(providerCleanupService, /provider\.cleanup\.drift_reopened/, 'scheduled cleanup must reopen a completed record when its scan instance still exists');
assert.match(providerCleanupService, /describeTencentEksContainerInstances/, 'scheduled cleanup must reconcile D1 completion markers against Tencent cloud state');
assert.match(tencentEksCiService, /DELETE_CONFIRM_ATTEMPTS = 4/, 'EKS deletion must use a bounded stabilization window');
assert.match(tencentEksCiService, /consecutiveAbsence >= requiredConsecutiveAbsence/, 'EKS deletion must require consecutive absence observations');
assert.match(tencentVpcService, /Name: 'address-ip'/, 'orphan EIP lookup must use the exact observed public IP');
assert.match(tencentVpcService, /status !== 'UNBIND'/, 'orphan EIP release must reject bound addresses');
assert.match(tencentVpcService, /ReleaseAddresses/, 'orphan EIP cleanup must call the Tencent VPC release API');
assert.match(tencentVpcService, /release was accepted but absence is not yet confirmed/, 'cleanup must not complete until the EIP is absent');
for (const workflow of [ci, text('.github/workflows/build-agent.yml')]) assert.match(workflow, /platforms: linux\/amd64/, 'agent image builds must target the Tencent EKS CI CPU architecture explicitly');
assert.doesNotMatch(main + bootstrap, /tencentcloud_cam_access_key|secret_key|secret_id/i, 'Terraform must not create or store CAM access keys');

assert.match(bootstrap, /resource "tencentcloud_cos_bucket"/);
assert.match(bootstrap, /acl\s+= "private"/);
assert.match(bootstrap, /encryption_algorithm\s+= "AES256"/);
assert.match(bootstrap, /versioning_enable\s+= true/);
assert.match(bootstrap, /prevent_destroy\s+= true/);
assert.match(versions, /backend "cos"/);
assert.match(versions, /version\s+= "= 1\.83\.21"/);

assert.match(ci, /terraform -chdir=infra\/tencent validate/);
assert.match(ci, /terraform -chdir=infra\/tencent\/bootstrap validate/);
assert.doesNotMatch(ci, /terraform[^\n]+ apply/, 'pull-request CI must never apply infrastructure');
assert.match(infraWorkflow, /environment: tencent-infrastructure/);
assert.match(infraWorkflow, /options: \[plan, apply, forget-retired-tcr-state\]/);
assert.match(infraWorkflow, /encrypt=true/);
assert.match(infraWorkflow, /state pull > tencent-state-before-retired-tcr\.json/);
assert.match(infraWorkflow, /path: tencent-state-before-retired-tcr\.json/);
for (const address of ['tencentcloud_tcr_repository.scan', 'tencentcloud_tcr_namespace.scan', 'tencentcloud_tcr_instance.scan']) assert.match(infraWorkflow, new RegExp(escapeRegExp(`'${address}'`)));
assert.match(infraWorkflow, /retention-days: 7/);
assert.match(infraWorkflow, /inputs\.action == 'plan' \|\| inputs\.action == 'apply'/, 'state reconciliation must not run a plan before stale TCR addresses are forgotten');
assert.match(stagingAcceptanceWorkflow, /environment: staging/);
assert.match(stagingDryrunPreflightWorkflow, /timeout-minutes: 15/, 'staging dry-run preflight must allow the full cleanup convergence window');
assert.match(stagingDryrunPreflightWorkflow, /ACCEPTANCE_CLEANUP_WAIT_MS: "600000"/, 'staging dry-run preflight must use the ten-minute cleanup convergence window');
assert.doesNotMatch(stagingDryrunPreflightWorkflow, /ACCEPTANCE_CLEANUP_WAIT_MS: "120000"/, 'staging dry-run preflight must not retain the obsolete 120-second window');
assert.match(stagingAcceptanceWorkflow, /concurrency:[\s\S]*group: staging-live-provider/);
assert.match(stagingAcceptanceWorkflow, /STAGING_ADMIN_TOKEN: \$\{\{ secrets\.STAGING_ADMIN_TOKEN \}\}/);
assert.match(stagingAcceptanceWorkflow, /TASK_MAX_RETRY = \\"1\\"','TASK_MAX_RETRY = \\"0\\"/);
assert.match(stagingAcceptanceWorkflow, /name: Refresh staging dry-run Worker/);
assert.match(stagingAcceptanceWorkflow, /name: Verify zero-instance precondition[\s\S]*verify-dry-run/);
assert.match(stagingAcceptanceWorkflow, /name: Verify live Queue consumer propagation[\s\S]*timeout-minutes: 3[\s\S]*verify-live-consumer/);
assert.match(stagingAcceptanceWorkflow, /name: Run one real mock container acceptance[\s\S]*timeout-minutes: 20[\s\S]*ACCEPTANCE_CLEANUP_WAIT_MS: "600000"/);
assert.match(stagingAcceptanceWorkflow, /name: Restore staging dry-run Worker[\s\S]*if: always\(\)/);
assert.match(stagingAcceptanceWorkflow, /name: Verify rollback and Tencent cleanup[\s\S]*if: always\(\)[\s\S]*timeout-minutes: 12[\s\S]*ACCEPTANCE_CLEANUP_WAIT_MS: "600000"/);
assert.match(stagingAcceptanceScript, /single-instance invariant violated/);
assert.match(stagingAcceptanceScript, /refusing to start: Tencent EKS CI instance list is not empty/);
assert.match(stagingAcceptanceScript, /refusing to start: staging has/);
assert.match(stagingAcceptanceScript, /timeout_minutes: 5/);
assert.match(stagingAcceptanceScript, /provider_egress_ip/);
assert.match(stagingAcceptanceScript, /AbortSignal\.timeout\(20_000\)/);
assert.match(stagingAcceptanceScript, /live acceptance was consumed by a dry-run Queue version/);
assert.match(stagingAcceptanceScript, /await waitForProviderMode\(false\)[\s\S]*await verifyConsumerCanary\(false\)/, 'live verification must wait for both HTTP and Queue propagation');
assert.match(stagingAcceptanceScript, /await waitForProviderMode\(true\)[\s\S]*verifyConsumerCanary\(true\)/, 'rollback verification must wait for both HTTP and Queue propagation');
assert.match(stagingAcceptanceScript, /waitForStableZeroInstances\(cleanupWaitMs[\s\S]*verifyConsumerCanary\(true\)/, 'dry-run verification must confirm stable Tencent absence before the guarded Queue consumer version');
assert.match(stagingAcceptanceScript, /cleanupWaitMs = clampNumber\(process\.env\.ACCEPTANCE_CLEANUP_WAIT_MS, 10 \* 60_000/);
assert.match(stagingAcceptanceScript, /waitForCleanupConvergence\(report, cleanupWaitMs\)/);
assert.match(stagingAcceptanceScript, /const \[response, cloud\] = await Promise\.all/);
assert.match(stagingAcceptanceScript, /cleanupComplete && consecutiveZero >= 3/, 'task cleanup must share one deadline for D1 completion and stable Tencent absence');
assert.match(stagingAcceptanceScript, /cleanup_completed = Boolean\(run\.provider_cleanup_completed_at\)/, 'acceptance reports must reflect cleanup marker reopening as well as completion');
assert.match(stagingAcceptanceScript, /provider_cleanup_last_error = run\.provider_cleanup_last_error \?\? null/, 'a successful cleanup retry must clear the stale report error');
assert.doesNotMatch(stagingAcceptanceScript, /waitForCleanup\(report, 90_000\)|waitForStableZeroInstances\(90_000/, 'staging cleanup must not retain the obsolete 90-second observation windows');
assert.match(stagingAcceptanceScript, /consecutiveZero >= 3/, 'staging acceptance must require three consecutive zero-instance observations');
assert.doesNotMatch(stagingAcceptanceScript, /const preflight = await preflight\(\)/, 'preflight verification must not shadow its own function');
assert.match(stagingRegistryDiagnosticWorkflow, /environment: staging/);
assert.match(stagingRegistryDiagnosticWorkflow, /group: staging-live-provider/);
assert.match(stagingRegistryDiagnosticWorkflow, /registry\.cn-hangzhou\.aliyuncs\.com\/google_containers\/pause@sha256:8d4106c88ec0bd28001e34c975d65175d994072d65341f62a8ab0754b0fafe10/);
assert.match(stagingRegistryDiagnosticWorkflow, /continue-on-error: true[\s\S]*ACCEPTANCE_MAX_WAIT_MS: "120000"/);
assert.match(stagingRegistryDiagnosticWorkflow, /name: Restore staging dry-run Worker[\s\S]*if: always\(\)/);
assert.match(stagingRegistryDiagnosticWorkflow, /name: Verify rollback and Tencent cleanup[\s\S]*if: always\(\)/);
assert.match(stagingRegistryDiagnosticWorkflow, /node scripts\/assert-staging-registry-connectivity\.mjs/);
assert.match(stagingRegistryDiagnosticScript, /ErrImagePull\|ImagePullBackOff\|Failed to pull\|DeadlineExceeded/);
assert.match(stagingRegistryDiagnosticScript, /diagnostics\.status, 'Running'/);
assert.match(stagingRegistryDiagnosticScript, /report\.cleanup_completed, true/);
assert.match(stagingRegistryDiagnosticScript, /tencent_instance_count_after/);

assert.match(pilotAcceptanceWorkflow, /environment: pilot/);
assert.match(pilotAcceptanceWorkflow, /group: pilot-live-acceptance/);
assert.match(pilotAcceptanceWorkflow, /randomBytes\(32\)\.toString\('base64url'\)/);
assert.match(pilotAcceptanceWorkflow, /::add-mask::\$\{token\}/);
assert.match(pilotAcceptanceWorkflow, /PILOT_ADMIN_TOKEN=%s\\n/);
assert.doesNotMatch(pilotAcceptanceWorkflow, /secrets\.PILOT_ACCEPTANCE_ADMIN_TOKEN/);
assert.match(pilotAcceptanceWorkflow, /test "\$PILOT_TARGET" = "70yun\.xyz"/);
assert.match(pilotAcceptanceWorkflow, /name: Restore Pilot application dry-run[\s\S]*if: always\(\)/);
assert.match(pilotAcceptanceWorkflow, /name: Verify rollback and zero Tencent instances[\s\S]*if: always\(\)/);
assert.match(pilotAcceptanceWorkflow, /name: Revoke the short-lived Pilot token[\s\S]*if: always\(\)/);
assert.match(pilotAcceptanceWorkflow, /max_cost_usd: 0\.7|ACCEPTANCE_MAX_WAIT_MS/, 'Pilot workflow must retain its bounded runtime and cost envelope');
assert.match(pilotAcceptanceScript, /targets: \[target\][\s\S]*target_urls: \[`https:\/\/\$\{target\}:443\/`\][\s\S]*modules: \['subdomain', 'http_probe', 'nuclei'\]/);
assert.match(pilotAcceptanceScript, /max_agents: 1[\s\S]*rate_limit: 1[\s\S]*timeout_minutes: 15[\s\S]*max_cost_usd: 0\.7/);
assert.match(pilotAcceptanceScript, /targetReport\.asset_hosts\.every\(\(host\) => host === target \|\| host\.endsWith\(`\.\$\{target\}`\)\)/);
assert.match(pilotAcceptanceScript, /httpx result escaped authorized root scope/);
assert.match(pilotAcceptanceScript, /for \(const stageName of \['subfinder', 'httpx', 'nuclei'\]\)/);
assert.match(pilotAcceptanceScript, /duration_seconds is missing/);
assert.match(pilotAcceptanceScript, /independent provider egress IP was not recorded/);
assert.match(pilotAcceptanceScript, /consecutiveZero >= 3/, 'Pilot acceptance must require three consecutive zero-instance observations');
assert.match(pilotAcceptanceScript, /Tencent EKS CI cleanup was not stable/);
assert.match(pilotTokenScript, /createHash\('sha256'\)/);
assert.match(pilotTokenScript, /scope_json = \?/);
assert.match(pilotTokenScript, /'\["70yun\.xyz"\]'/);
assert.match(pilotTokenScript, /revoked_at = COALESCE\(revoked_at, \?\)/);
assert.doesNotMatch(pilotTokenScript, /console\.log\([^\n]*rawToken/, 'Pilot token plaintext must never be logged');

assert.match(staging, /ENVIRONMENT=staging/);
assert.match(staging, /TOKEN_SCOPE_ENFORCEMENT=report/);
assert.match(staging, /TENCENT_EKS_CI_DRY_RUN=true/);
assert.match(staging, /TENCENT_EKS_CI_AUTO_CREATE_EIP=true/);
assert.match(pilot, /ENVIRONMENT=pilot/);
assert.match(pilot, /TOKEN_SCOPE_ENFORCEMENT=enforce/);
assert.match(pilot, /AGENT_SCAN_MODE=real_toolchain/);
assert.match(pilot, /AGENT_MAX_CANDIDATES=100/);
assert.match(pilot, /TASK_MAX_RETRY=0/);
assert.match(pilot, /TENCENT_EKS_CI_DRY_RUN=true/);
assert.match(pilot, /TENCENT_EKS_CI_AUTO_CREATE_EIP=true/);
for (const envConfig of [staging, pilot]) {
  assert.match(envConfig, /TENCENT_EKS_CI_IMAGE=registry-intl\.cn-chengdu\.aliyuncs\.com\/70v2ray\/scan-agent-cloud@sha256:replace/);
  assert.match(envConfig, /TENCENT_EKS_CI_ALLOWED_REGISTRY_HOST=registry-intl\.cn-chengdu\.aliyuncs\.com/);
  assert.doesNotMatch(envConfig, /TENCENT_TCR_|tencentcloudcr/);
}

console.log(JSON.stringify({ ok: true, isolated_environments: ['staging', 'pilot'], per_run_auto_eip: true, shared_nat: false, ordered_egress_denies: true, cos_encrypted_versioned_backend: true, cam_access_keys_in_state: false, tcr_managed: false, image_registry: 'public-aliyun-acr-chengdu', ci_apply_disabled: true, network: 'not used', cloud_credentials: 'not used' }, null, 2));

function text(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
