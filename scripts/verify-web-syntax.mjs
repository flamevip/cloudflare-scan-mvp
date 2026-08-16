import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [index, rootWrangler, remoteWrangler, client, agentRoutes] = await Promise.all([
  readFile(resolve(root, 'web/dist/index.html'), 'utf8'),
  readFile(resolve(root, 'wrangler.toml'), 'utf8'),
  readFile(resolve(root, 'config/wrangler.tencent.template.toml'), 'utf8'),
  readFile(resolve(root, 'web/src/api/client.ts'), 'utf8'),
  readFile(resolve(root, 'worker/src/routes/agent.ts'), 'utf8'),
]);

assert.match(index, /<div id="app"><\/div>/, 'Vite build must contain the Vue application mount');
assert.match(index, /\/assets\/[^"']+\.js/, 'Vite build must reference a hashed JavaScript bundle');
assert.match(rootWrangler, /\[assets\][\s\S]*directory = "web\/dist"/);
assert.match(remoteWrangler, /\[assets\][\s\S]*directory = "\.\.\/web\/dist"/);
for (const config of [rootWrangler, remoteWrangler]) {
  assert.match(config, /not_found_handling = "single-page-application"/);
  assert.match(config, /run_worker_first = \["\/api\/\*", "\/health"\]/);
}
assert.doesNotMatch(client, /localStorage[^\n]*(token|bearer)/i, 'API token must not use localStorage');
assert.doesNotMatch(index, /dev-token|Bearer Token/, 'built HTML shell must not contain a default credential');
assert.match(agentRoutes, /\/api\/agent\//, 'agent callback routes must remain Worker routes');

const indexStat = await stat(resolve(root, 'web/dist/index.html'));
assert.ok(indexStat.size > 100, 'built index must not be empty');

console.log(JSON.stringify({
  ok: true,
  framework: 'vue3',
  static_assets: true,
  spa_fallback: true,
  api_worker_first: true,
  session_token_storage: true,
}, null, 2));
