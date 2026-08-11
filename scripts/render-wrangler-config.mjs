import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const templatePath = resolve(root, process.argv[2] || 'config/wrangler.tencent.template.toml');
const outputPath = resolve(root, process.argv[3] || 'work/wrangler.generated.toml');
const template = await readFile(templatePath, 'utf8');
validateInputs(process.env);
const missing = new Set();
const rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
  const value = process.env[key];
  if (!value) {
    missing.add(key);
    return '';
  }
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
});
if (missing.size) {
  throw new Error(`missing required Wrangler render variables: ${[...missing].sort().join(', ')}`);
}
if (/\b(replace|sha256:replace)\b/i.test(rendered)) throw new Error('rendered Wrangler config still contains placeholder values');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, rendered, 'utf8');
console.log(outputPath);

function validateInputs(env) {
  const values = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value ?? '')]));
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n\0]/.test(value)) throw new Error(`${key} contains a forbidden control character`);
  }
  if (!['staging', 'pilot'].includes(values.ENVIRONMENT)) throw new Error('ENVIRONMENT must be staging or pilot');
  const expectedEnforcement = values.ENVIRONMENT === 'pilot' ? 'enforce' : 'report';
  if (values.TOKEN_SCOPE_ENFORCEMENT !== expectedEnforcement) throw new Error(`TOKEN_SCOPE_ENFORCEMENT must be ${expectedEnforcement} for ${values.ENVIRONMENT}`);
  const expectedMode = values.ENVIRONMENT === 'pilot' ? 'real_toolchain' : 'mock';
  if (values.AGENT_SCAN_MODE !== expectedMode) throw new Error(`AGENT_SCAN_MODE must be ${expectedMode} for ${values.ENVIRONMENT}`);
  if (!['true', 'false'].includes(values.TENCENT_EKS_CI_DRY_RUN)) throw new Error('TENCENT_EKS_CI_DRY_RUN must be true or false');
  if (!/^https:\/\/[^\s/]+(?:\/.*)?$/i.test(values.CALLBACK_BASE_URL) || /localhost|127\.0\.0\.1|\[::1\]/i.test(values.CALLBACK_BASE_URL)) {
    throw new Error('CALLBACK_BASE_URL must be a non-local HTTPS URL');
  }
  const image = values.TENCENT_EKS_CI_IMAGE.match(/^([^/]+)\/.+@sha256:[a-f0-9]{64}$/i);
  if (!image) throw new Error('TENCENT_EKS_CI_IMAGE must be pinned by sha256 digest');
  if (image[1].toLowerCase() !== values.TENCENT_EKS_CI_ALLOWED_REGISTRY_HOST.toLowerCase()) {
    throw new Error('TENCENT_EKS_CI_ALLOWED_REGISTRY_HOST must match the image registry host');
  }
  const maxCandidates = Number(values.AGENT_MAX_CANDIDATES);
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 500 || (values.ENVIRONMENT === 'pilot' && maxCandidates > 100)) {
    throw new Error('AGENT_MAX_CANDIDATES must be 1..500 and at most 100 in pilot');
  }
}
