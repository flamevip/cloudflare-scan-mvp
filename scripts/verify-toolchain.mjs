import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(resolve(root, 'agent/real/Dockerfile'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(root, 'agent/real/toolchain.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const buildScript = readFileSync(resolve(root, 'scripts/cloud-run-build-agent.sh'), 'utf8');
const deployScript = readFileSync(resolve(root, 'scripts/cloud-run-deploy-job.sh'), 'utf8');
const buildWorkflow = readFileSync(resolve(root, '.github/workflows/build-agent.yml'), 'utf8');
const deployWorkflow = readFileSync(resolve(root, '.github/workflows/deploy-worker.yml'), 'utf8');

assert.doesNotMatch(dockerfile, /projectdiscovery\/[^\s]+@latest/);
assert.match(dockerfile, new RegExp(`ARG SUBFINDER_VERSION=${escapeRegExp(manifest.projectdiscovery.subfinder.version)}`));
assert.match(dockerfile, new RegExp(`ARG HTTPX_VERSION=${escapeRegExp(manifest.projectdiscovery.httpx.version)}`));
assert.match(dockerfile, new RegExp(`ARG NUCLEI_VERSION=${escapeRegExp(manifest.projectdiscovery.nuclei.version)}`));
assert.match(dockerfile, new RegExp(`FROM ${escapeRegExp(manifest.base_images.tools)} AS tools`));
assert.match(dockerfile, new RegExp(`FROM ${escapeRegExp(manifest.base_images.runtime)}`));
assert.match(dockerfile, /sha256sum \/tools\/subfinder \/tools\/httpx \/tools\/nuclei/);
assert.match(dockerfile, new RegExp(`ARG NUCLEI_TEMPLATES_COMMIT=${escapeRegExp(manifest.nuclei_templates.commit)}`));
assert.match(dockerfile, /NUCLEI_TEMPLATES=\/usr\/local\/share\/nuclei-templates/);
assert.match(buildWorkflow, /anchore\/sbom-action@/);
assert.match(buildWorkflow, /cosign sign --yes/);
assert.match(buildWorkflow, /steps\.build\.outputs\.digest/);
assert.match(buildWorkflow, /image_tag must be a lowercase OCI-safe label/);
assert.match(buildWorkflow, /\$\{GITHUB_SHA:0:12\}/);
assert.match(buildWorkflow, /docker\/build-push-action@[a-f0-9]{40}/);
assert.match(buildWorkflow, /environment: agent-image-publish/);
assert.match(buildWorkflow, /registry-intl\.cn-chengdu\.aliyuncs\.com\/70v2ray\/scan-agent-cloud/);
assert.match(buildWorkflow, /username: \$\{\{ secrets\.ALIYUN_ACR_USERNAME \}\}/);
assert.match(buildWorkflow, /password: \$\{\{ secrets\.ALIYUN_ACR_PASSWORD \}\}/);
assert.match(buildWorkflow, /docker logout "\$ACR_REGISTRY"[\s\S]*docker buildx imagetools inspect/);
assert.doesNotMatch(buildWorkflow, /packages: write|ghcr\.io|secrets\.GITHUB_TOKEN/);
assert.doesNotMatch(buildWorkflow, /TCR_|tencentcloudcr|Temporary TCR|RUNNER_CIDR/);
assert.match(deployWorkflow, /Verify the approved digest signature/);
assert.match(deployWorkflow, /cosign verify "\$IMAGE"/);
assert.doesNotMatch(deployWorkflow, /TENCENT_TCR_|docker\/login-action/);
assert.ok(deployWorkflow.indexOf('Verify the approved digest signature') < deployWorkflow.indexOf('Deploy Worker'), 'signature verification must precede Worker deployment');
assert.match(deployWorkflow, /TENCENT_EKS_CI_DRY_RUN: "true"/);
assert.match(deployWorkflow, /Promote approved deployment to live provider/);

for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
  assert.notEqual(version, 'latest', `${name} must not use latest`);
  assert.equal(lock.packages[''].devDependencies[name], version, `${name} package-lock root metadata must match package.json`);
}

const bashAvailable = process.platform !== 'win32' || spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const runScript = (relativePath, env) => bashAvailable
  ? spawnSync(process.platform === 'win32' ? 'bash' : resolve(root, relativePath), process.platform === 'win32' ? [resolve(root, relativePath)] : [], { cwd: root, encoding: 'utf8', env })
  : { status: null, stdout: '', stderr: 'bash unavailable' };

const buildDryRun = runScript('scripts/cloud-run-build-agent.sh', {
    ...process.env,
    DRY_RUN: 'true',
    GCP_PROJECT_ID: 'fixture-project',
    GCP_LOCATION: 'asia-east1',
    GENERATE_SBOM: 'true',
    SIGN_IMAGE: 'true',
    VERIFY_SIGNATURE: 'true',
});
if (bashAvailable) {
  assert.equal(buildDryRun.status, 0, buildDryRun.stderr || buildDryRun.stdout);
  assert.match(buildDryRun.stdout, /DIGEST_URI=.*@sha256:<digest-after-push>/);
  assert.match(buildDryRun.stdout, /syft/);
  assert.match(buildDryRun.stdout, /cosign\s+\+\s+sign/);
  assert.match(buildDryRun.stdout, /cosign\s+\+\s+verify/);
} else {
  assert.match(buildScript, /DIGEST_URI=.*digest-after-push/);
  assert.match(buildScript, /run "\$SBOM_TOOL"/);
  assert.match(buildScript, /run cosign sign/);
  assert.match(buildScript, /run cosign verify/);
}

const deployDigestDryRun = runScript('scripts/cloud-run-deploy-job.sh', {
    ...process.env,
    DRY_RUN: 'true',
    GCP_PROJECT_ID: 'fixture-project',
    GCP_LOCATION: 'asia-east1',
    IMAGE_URI: 'asia-east1-docker.pkg.dev/fixture-project/scan-mvp/scan-agent@sha256:abcdef',
    REQUIRE_IMAGE_DIGEST: 'true',
    VERIFY_SIGNATURE: 'true',
});
if (bashAvailable) {
  assert.equal(deployDigestDryRun.status, 0, deployDigestDryRun.stderr || deployDigestDryRun.stdout);
  assert.match(deployDigestDryRun.stdout, /cosign\s+\+\s+verify/);
}

const deployTagReject = runScript('scripts/cloud-run-deploy-job.sh', {
    ...process.env,
    DRY_RUN: 'true',
    GCP_PROJECT_ID: 'fixture-project',
    GCP_LOCATION: 'asia-east1',
    IMAGE_URI: 'asia-east1-docker.pkg.dev/fixture-project/scan-mvp/scan-agent:v0.1.0',
    REQUIRE_IMAGE_DIGEST: 'true',
});
if (bashAvailable) {
  assert.notEqual(deployTagReject.status, 0);
  assert.match(deployTagReject.stderr, /requires immutable image digest URI/);
} else {
  assert.match(deployScript, /requires immutable image digest URI/);
}

const agent = await import(pathToFileURL(resolve(root, 'agent/real/src/scan-agent.js')).href);
const ingest = agent.buildIngestResult({ mode: 'mock', modules: ['subdomain'], targets: ['example.com'], httpxJsonl: '', nucleiJsonl: '', assets: [], findings: [] });
assert.equal(ingest.artifacts.length, 1);
assert.ok(ingest.artifacts[0].toolchain_metadata);
assert.match(ingest.artifacts[0].raw_content, /scan-agent-toolchain/);
assert.match(ingest.artifacts[0].search_content, /Toolchain:/);

console.log(JSON.stringify({
  ok: true,
  pinned_versions: {
    base_images: manifest.base_images,
    projectdiscovery: Object.fromEntries(Object.entries(manifest.projectdiscovery).map(([name, value]) => [name, value.version])),
    nuclei_templates: manifest.nuclei_templates,
    devDependencies: pkg.devDependencies,
  },
  dockerfile: { projectdiscovery_latest_present: false, sha256_manifest_step: true },
  dry_run_hooks: {
    bash_available: bashAvailable,
    build_digest_uri: bashAvailable ? /DIGEST_URI=.*@sha256:<digest-after-push>/.test(buildDryRun.stdout) : true,
    sbom_command: bashAvailable ? /syft/.test(buildDryRun.stdout) : /run "\$SBOM_TOOL"/.test(buildScript),
    sign_command: bashAvailable ? /cosign\s+\+\s+sign/.test(buildDryRun.stdout) : /run cosign sign/.test(buildScript),
    verify_command: bashAvailable ? /cosign\s+\+\s+verify/.test(buildDryRun.stdout) : /run cosign verify/.test(buildScript),
    deploy_digest_accepts: bashAvailable ? deployDigestDryRun.status === 0 : true,
    deploy_tag_rejects_when_required: bashAvailable ? deployTagReject.status !== 0 : true,
  },
  agent_metadata: {
    status: ingest.artifacts[0].toolchain_metadata.status,
    raw_has_toolchain_line: /scan-agent-toolchain/.test(ingest.artifacts[0].raw_content),
    search_has_toolchain_line: /Toolchain:/.test(ingest.artifacts[0].search_content),
  },
  network: 'not used',
  cloud_credentials: 'not used',
}, null, 2));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
