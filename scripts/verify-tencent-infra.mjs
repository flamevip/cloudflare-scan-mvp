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
const staging = text('config/staging.env.example');
const pilot = text('config/pilot.env.example');

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
for (const action of ['tke:CreateEKSContainerInstances', 'tke:DescribeEKSContainerInstances', 'tke:DeleteEKSContainerInstances']) assert.match(main, new RegExp(action));
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
assert.match(infraWorkflow, /options: \[plan, apply\]/);
assert.match(infraWorkflow, /encrypt=true/);

assert.match(staging, /ENVIRONMENT=staging/);
assert.match(staging, /TOKEN_SCOPE_ENFORCEMENT=report/);
assert.match(staging, /TENCENT_EKS_CI_DRY_RUN=true/);
assert.match(staging, /TENCENT_EKS_CI_AUTO_CREATE_EIP=true/);
assert.match(pilot, /ENVIRONMENT=pilot/);
assert.match(pilot, /TOKEN_SCOPE_ENFORCEMENT=enforce/);
assert.match(pilot, /AGENT_SCAN_MODE=real_toolchain/);
assert.match(pilot, /AGENT_MAX_CANDIDATES=100/);
assert.match(pilot, /TENCENT_EKS_CI_DRY_RUN=true/);
assert.match(pilot, /TENCENT_EKS_CI_AUTO_CREATE_EIP=true/);
for (const envConfig of [staging, pilot]) {
  assert.match(envConfig, /TENCENT_EKS_CI_IMAGE=ghcr\.io\/flamevip\/cloudflare-scan-mvp-agent@sha256:replace/);
  assert.match(envConfig, /TENCENT_EKS_CI_ALLOWED_REGISTRY_HOST=ghcr\.io/);
  assert.doesNotMatch(envConfig, /TENCENT_TCR_|tencentcloudcr/);
}

console.log(JSON.stringify({ ok: true, isolated_environments: ['staging', 'pilot'], per_run_auto_eip: true, shared_nat: false, ordered_egress_denies: true, cos_encrypted_versioned_backend: true, cam_access_keys_in_state: false, tcr_managed: false, image_registry: 'public-ghcr', ci_apply_disabled: true, network: 'not used', cloud_credentials: 'not used' }, null, 2));

function text(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
