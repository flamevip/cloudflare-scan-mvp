import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const contracts = loadTsModule('worker/src/contracts.ts');
const scope = loadTsModule('worker/src/services/scope-validation.ts', {
  '../response': { HttpError },
});
const auth = loadTsModule('worker/src/auth.ts', {
  './response': { HttpError },
  './ids': { newId: (prefix) => `${prefix}_test`, nowIso: () => '2026-06-12T00:00:00.000Z' },
});
const hunter = loadTsModule('worker/src/services/hunter-service.ts', {
  '../ids': { newId: (prefix) => `${prefix}_test`, nowIso: () => '2026-06-12T00:00:00.000Z' },
  './scope-validation': scope,
  './r2-service': {
    externalCandidatesKey: (taskId, provider) => `tenants/default/tasks/${taskId}/external/${provider}/candidates.txt`,
    externalSourceNormalizedKey: (taskId, shardId, provider) => `tenants/default/tasks/${taskId}/external/${provider}/${shardId}/normalized.jsonl`,
    externalSourceRawKey: (taskId, shardId, provider, name) => `tenants/default/tasks/${taskId}/external/${provider}/${shardId}/raw/${name}`,
    putText: async () => undefined,
  },
});
const retryPolicy = loadTsModule('worker/src/services/retry-policy.ts');
const configValidation = loadTsModule('worker/src/services/config-validation.ts');
const searchService = loadTsModule('worker/src/services/search-service.ts', {
  '../auth': { projectFilter: () => ({ sql: 't.project_id IN (?)', bindings: ['project-default'] }) },
  '../response': { HttpError },
  './task-service': { requireTaskAccess: async () => ({ id: 'task_test', project_id: 'project-default' }) },
  './config-validation': configValidation,
});

assert.deepEqual(plain(contracts.normalizeScanModules(undefined)), ['subdomain', 'http_probe', 'nuclei']);
assert.deepEqual(plain(contracts.normalizeScanModules(['SUBDOMAIN', 'http_probe', 'subdomain'])), ['subdomain', 'http_probe']);
assert.throws(() => contracts.normalizeScanModules(['subdomain', 'port_scan']), /unsupported scan module/);
assert.deepEqual(plain(contracts.normalizeExternalSources(undefined)), []);
assert.deepEqual(plain(contracts.normalizeExternalSources(['Hunter', 'hunter'])), ['hunter']);
assert.throws(() => contracts.normalizeExternalSources(['raw_query']), /unsupported external source provider/);
assert.equal(contracts.isAgentScanMode('mock'), true);
assert.equal(contracts.isAgentScanMode('http_probe'), true);
assert.equal(contracts.isAgentScanMode('real_toolchain'), true);
assert.equal(contracts.isAgentScanMode('masscan'), false);
assert.equal(contracts.TERMINAL_TASK_STATUSES.includes('timeout'), true);
assert.equal(contracts.DEFAULT_RATE_LIMIT, 50);
assert.equal(contracts.DEFAULT_TIMEOUT_MINUTES, 30);

const allowedRoots = scope.parseProjectScope('["example.com"]');
assert.deepEqual(plain(allowedRoots), ['example.com']);
assert.deepEqual(plain(scope.validateTargets(['example.com', 'www.example.com'], allowedRoots)), ['example.com', 'www.example.com']);
assert.deepEqual(plain(scope.validateTargetUrls(['https://api.example.com:8443/health'], allowedRoots, ['example.com'])), ['https://api.example.com:8443/health']);
assert.throws(() => scope.validateTargets(['evil.com'], allowedRoots), /outside project scope/);
assert.throws(() => scope.validateTargets(['127.0.0.1'], allowedRoots), /raw IP targets are not allowed/);
assert.throws(() => scope.validateTargets(['metadata.google.internal'], allowedRoots), /target is not allowed/);
assert.throws(() => scope.validateTargets(['bad host'], allowedRoots), /invalid domain target/);
assert.throws(() => scope.validateTargetUrls(['https://evil.com:8443/'], allowedRoots, ['example.com']), /outside project scope/);
assert.throws(() => scope.validateTargetUrls(['http://127.0.0.1:8000/'], allowedRoots, ['example.com']), /raw IP targets are not allowed/);
assert.throws(() => scope.validateTargetUrls(['http://metadata.google.internal:8000/'], allowedRoots, ['example.com']), /target is not allowed/);
assert.throws(() => scope.validateTargetUrls(['ftp://api.example.com:21/'], allowedRoots, ['example.com']), /scheme is not allowed/);
assert.throws(() => scope.validateTargetUrls(['http://user:pass@api.example.com:8000/'], allowedRoots, ['example.com']), /credentials are not allowed/);
assert.throws(() => scope.validateTargetUrls(['https://api.example.com/health'], allowedRoots, ['example.com']), /explicit port/);
assert.throws(() => scope.validateTargetUrls(['https://api.example.com:8443/health'], allowedRoots, ['www.example.com']), /outside task scope/);
assert.equal(scope.isHostInScope('api.example.com', allowedRoots), true);
assert.equal(scope.isHostInScope('api.evil.com', allowedRoots), false);

const hunterConfig = hunter.readHunterConfig({
  HUNTER_ENABLED: 'true',
  HUNTER_API_KEY: 'fixture-key',
  HUNTER_PAGE_SIZE: '2',
  HUNTER_MAX_PAGES: '1',
  HUNTER_MAX_RESULTS: '3',
  HUNTER_TIMEOUT_MS: '1000',
});
assert.equal(hunterConfig.enabled, true);
assert.equal(hunterConfig.pageSize, 2);
assert.equal(hunter.buildHunterQuery('example.com', hunterConfig), 'domain="example.com"');
assert.equal(hunter.shouldRunHunter(['hunter']), true);
assert.equal(hunter.shouldRunHunter([]), false);
const hunterCandidate = hunter.normalizeHunterRecord({ url: 'https://api.example.com/login', title: 'Login', status_code: 200 }, allowedRoots);
assert.equal(hunterCandidate.host, 'api.example.com');
assert.equal(hunterCandidate.asset_key, 'https:api.example.com:443');
assert.equal(hunter.normalizeHunterRecord({ url: 'https://evil.com/' }, allowedRoots), null);

const devEnv = { DEV_ADMIN_TOKEN: 'dev-token', DEFAULT_PROJECT_ID: 'project-default' };
const devRequest = new Request('http://scan.local/api/tasks', { headers: { Authorization: 'Bearer dev-token' } });
const context = await auth.requireAuthContext(devRequest, devEnv);
assert.equal(context.actor_id, 'admin');
assert.equal(context.role, 'admin');
assert.deepEqual(plain(context.project_ids), ['project-default']);
assert.equal(auth.canAccessProject(context, 'project-default'), true);
assert.equal(auth.canAccessProject(context, 'other-project'), false);
await assert.rejects(() => auth.requireAuthContext(new Request('http://scan.local/api/tasks'), devEnv), /missing or invalid bearer token/);

assert.deepEqual(plain(retryPolicy.decideRetry({ attempt: 1, maxRetry: 1, retryable: true })), { action: 'retry', next_attempt: 2, reason: 'attempt 1 of 2' });
assert.equal(retryPolicy.decideRetry({ attempt: 2, maxRetry: 1, retryable: true }).action, 'deadletter');
assert.equal(retryPolicy.decideRetry({ attempt: 1, maxRetry: 3, retryable: false }).reason, 'failure is not retryable');
assert.equal(retryPolicy.decideTimeout({ status: 'running', lastHeartbeatAt: '2026-06-12T00:00:00.000Z', createdAt: '2026-06-12T00:00:00.000Z', now: '2026-06-12T00:11:00.000Z', timeoutSeconds: 600 }).timed_out, true);
assert.equal(retryPolicy.decideTimeout({ status: 'success', createdAt: '2026-06-12T00:00:00.000Z', now: '2026-06-12T00:11:00.000Z', timeoutSeconds: 600 }).timed_out, false);

const searchUrl = new URL('http://scan.local/api/search?q=login&task_id=task_test&type=agent_mock_raw&limit=5');
assert.deepEqual(plain(searchService.parseSearchParams(searchUrl, '10')), { q: 'login', task_id: 'task_test', type: 'agent_mock_raw', limit: 5 });
assert.throws(() => searchService.parseSearchParams(new URL('http://scan.local/api/search?q='), '10'), /q is required/);
assert.equal(searchService.extractR2Key({ metadata: { key: 'tenants/default/tasks/task_test/search/mock/doc.md' } }), 'tenants/default/tasks/task_test/search/mock/doc.md');
assert.equal(searchService.parseTaskIdFromSearchKey('tenants/default/tasks/task_test/search/mock/doc.md'), 'task_test');

function loadTsModule(relativePath, requireMap = {}) {
  const filePath = resolve(root, relativePath);
  const source = readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    exports: module.exports,
    module,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`verify-p0 cannot load ${specifier} from ${relativePath}`);
    },
    Request,
    URL,
    crypto,
    TextEncoder,
  };
  vm.runInNewContext(compiled, sandbox, { filename: filePath });
  return module.exports;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    'default modules',
    'module normalization and dedupe',
    'unsupported module rejection',
    'external source allowlist',
    'agent scan mode allowlist',
    'terminal status contract',
    'bounded defaults',
    'project allowlist target acceptance',
    'authorized exact target URL acceptance',
    'outside scope rejection',
    'private/raw/malformed target rejection',
    'unsafe exact target URL rejection',
    'dev token auth context',
    'project access predicate',
    'Hunter config parsing',
    'Hunter root-domain-derived query',
    'Hunter candidate normalization and scope rejection',
    'retry vs deadletter decision',
    'heartbeat timeout decision',
    'search parameter bounds',
    'search R2 key extraction and task fallback parsing',
  ],
  examples: {
    allowed_target: 'www.example.com under project scope [example.com]',
    allowed_target_url: 'https://api.example.com:8443/health under project/task scope [example.com]',
    rejected_targets: ['evil.com', '127.0.0.1', 'metadata.google.internal', 'bad host'],
    rejected_target_urls: ['https://evil.com:8443/', 'http://127.0.0.1:8000/', 'ftp://api.example.com:21/', 'https://api.example.com/health'],
    allowed_project: 'project-default',
    rejected_project: 'other-project',
    hunter_query: 'domain="example.com"',
    hunter_candidate: 'https:api.example.com:443',
    rejected_hunter_candidate: 'https://evil.com/',
  },
  network: 'not used',
  cloud_credentials: 'not used',
}, null, 2));
