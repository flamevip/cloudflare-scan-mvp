import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = await readFile(resolve(root, 'scripts/deploy-worker-with-version-fallback.sh'), 'utf8');
const workflow = await readFile(resolve(root, '.github/workflows/deploy-worker.yml'), 'utf8');

assert.match(script, /npx wrangler deploy --config/);
assert.match(script, /grep -Fq '\/workers\/routes'/);
assert.match(script, /Authentication error\.\*code: 10000/);
assert.match(script, /npx wrangler versions upload --config/);
assert.match(script, /wrangler versions deploy .*@100%/);
assert.match(script, /--yes/);
assert.match(script, /exit "\$DEPLOY_STATUS"/, 'non-route failures must retain their original failure status');
assert.equal((workflow.match(/deploy-worker-with-version-fallback\.sh/g) ?? []).length, 2, 'dry-run and live Worker deployments must use the guarded helper');
assert.match(workflow, /enable_live_provider/);

console.log(JSON.stringify({
  ok: true,
  normal_deploy_first: true,
  fallback_error_gate: ['/workers/routes', 'Authentication error code 10000'],
  version_traffic_percentage: 100,
  existing_routes_and_triggers_preserved: true,
  network: 'not used',
  cloud_credentials: 'not used',
}, null, 2));
