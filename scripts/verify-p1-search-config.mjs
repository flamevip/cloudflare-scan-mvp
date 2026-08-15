import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const response = loadTsModule('worker/src/response.ts');
const configValidation = loadTsModule('worker/src/services/config-validation.ts');
const auth = loadTsModule('worker/src/auth.ts', {
  './response': response,
  './ids': { newId: (prefix) => `${prefix}_test`, nowIso: () => '2026-06-15T00:00:00.000Z' },
});
const taskServiceStub = {
  requireTaskAccess: async (_env, context, taskId) => {
    if (taskId === 'task-alpha' && context.project_ids.includes('project-alpha')) return { id: taskId, project_id: 'project-alpha' };
    throw new response.HttpError(404, 'task not found');
  },
};
const searchService = loadTsModule('worker/src/services/search-service.ts', {
  '../auth': auth,
  '../response': response,
  './task-service': taskServiceStub,
  './config-validation': configValidation,
});
const searchRoute = loadTsModule('worker/src/routes/search.ts', {
  '../env': {},
  '../auth': auth,
  '../response': response,
  '../services/search-service': searchService,
});

const readerHash = await auth.hashBearerToken('reader-token-fixture');
function makeFakeDB(readerHash) {
  return {
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes('MIN(created_at) AS oldest_created_at')) return { count: 2, oldest_created_at: '2026-06-14T00:00:00.000Z', latest_created_at: '2099-01-01T00:00:00.000Z', last_24h_count: 1 };
          if (sql.includes('FROM api_tokens')) {
            if (this.values[0] !== readerHash) return null;
            return { token_id: 'tok_reader', user_id: 'reader-user', token_hash: readerHash, scopes_json: '["tasks:read"]', expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null, user_role: 'reader', email: 'reader@example.local' };
          }
          if (sql.includes('FROM artifacts ar INNER JOIN tasks t')) {
            const key = this.values[0];
            if (key === 'tenants/default/tasks/task-alpha/search/valid.md') {
              return { artifact_id: 'artifact-alpha', task_id: 'task-alpha', type: 'agent_search_doc', search_r2_key: key, raw_r2_key: 'raw-alpha', created_at: '2026-06-15T00:00:00.000Z' };
            }
            return null;
          }
          throw new Error(`unexpected first SQL: ${sql}`);
        },
        async all() {
          if (sql.includes('FROM project_memberships')) return { results: [{ project_id: 'project-alpha', role: 'reader' }] };
          if (sql.includes('ORDER BY ar.created_at DESC')) return { results: [{ artifact_id: 'artifact-alpha', task_id: 'task-alpha', type: 'agent_search_doc', search_r2_key: 'tenants/default/tasks/task-alpha/search/valid.md', raw_r2_key: 'raw-alpha', created_at: '2099-01-01T00:00:00.000Z' }] };
          throw new Error(`unexpected all SQL: ${sql}`);
        },
        async run() {
          return { success: true };
        },
      };
      return statement;
    },
  };
}

const envBase = {
  DEV_ADMIN_TOKEN: 'dev-token',
  DEFAULT_PROJECT_ID: 'project-default',
  AGENT_PROVIDER: 'mock',
  AI_SEARCH_LIMIT: '10',
  AI_SEARCH_INDEXING_GRACE_SECONDS: '900',
  DB: makeFakeDB(readerHash),
  ARTIFACTS: {
    async get(key) {
      if (key !== 'tenants/default/tasks/task-alpha/search/valid.md') return null;
      return { size: 96, async text() { return '# Scan results\nTargets: 70yun.xyz\nFinding: login endpoint'; } };
    },
  },
};
const context = {
  actor_id: 'reader-user',
  role: 'reader',
  project_ids: ['project-alpha'],
  project_roles: { 'project-alpha': 'reader' },
  memberships: [{ project_id: 'project-alpha', role: 'reader' }],
  token_type: 'api_token',
  token_scopes: ['tasks:read'],
};

const disabled = await searchService.searchArtifacts({ ...envBase, AI_SEARCH_ENABLED: 'false' }, context, new URL('http://scan.local/api/search?q=login'));
assert.equal(disabled.degraded, true);
assert.equal(Array.isArray(disabled.items), true);
assert.equal(disabled.items.length, 0);
assert.equal(disabled.error.code, 'ai_search_unconfigured');
assert.equal(typeof disabled.metadata.duration_ms, 'number');

const missingBindingValidation = configValidation.validateRuntimeConfig({ ...envBase, AI_SEARCH_ENABLED: 'true', AI_SEARCH_LIMIT: '100', AI_SEARCH_INDEXING_GRACE_SECONDS: '10', AGENT_PROVIDER: 'gcp_cloud_run', TASK_MAX_RETRY: 'abc', AGENT_HEARTBEAT_TIMEOUT_SECONDS: '10' });
assert.equal(missingBindingValidation.ok, false);
assert.ok(missingBindingValidation.errors.some((issue) => issue.code === 'ai_search_binding_missing'));
assert.ok(missingBindingValidation.errors.some((issue) => issue.field === 'AI_SEARCH_LIMIT'));
assert.ok(missingBindingValidation.errors.some((issue) => issue.field === 'AI_SEARCH_INDEXING_GRACE_SECONDS'));
assert.ok(missingBindingValidation.errors.some((issue) => issue.field === 'TASK_MAX_RETRY'));
assert.ok(missingBindingValidation.errors.some((issue) => issue.field === 'AGENT_HEARTBEAT_TIMEOUT_SECONDS'));
assert.ok(missingBindingValidation.errors.some((issue) => issue.code === 'provider_config_missing'));

const mixedEnv = {
  ...envBase,
  AI_SEARCH_ENABLED: 'true',
  AI_SEARCH: {
    async search() {
      return { chunks: [
        { metadata: { key: 'tenants/default/tasks/task-alpha/search/valid.md' }, text: 'valid artifact', score: 0.99 },
        { key: 'tenants/default/tasks/task-alpha/search/stale.md', text: 'stale deleted artifact', score: 0.75 },
        { text: 'no key chunk', score: 0.2 },
        { key: 'tenants/default/tasks/task-other/search/nope.md', text: 'other project', score: 0.1 },
      ] };
    },
    async info() { return { name: 'fixture-index' }; },
    async stats() { return { document_count: 2 }; },
  },
};
const mixed = await searchService.searchArtifacts(mixedEnv, context, new URL('http://scan.local/api/search?q=login&limit=10'));
assert.equal(mixed.degraded, false);
assert.equal(mixed.metadata.chunks_seen, 4);
assert.equal(mixed.metadata.chunks_with_r2_key, 3);
assert.equal(mixed.metadata.items_authorized, 1);
assert.equal(mixed.metadata.items_returned, 1);
assert.equal(mixed.metadata.mapping_misses, 3);
assert.equal(mixed.metadata.fallback_used, false);
assert.equal(mixed.metadata.indexing_state, 'searchable');
assert.equal(mixed.items.some((item) => item.artifact_id === null), false, 'stale AI Search chunks must not bypass D1 artifact mapping');

const fallback = await searchService.searchArtifacts({
  ...mixedEnv,
  AI_SEARCH: { async search() { return { chunks: [] }; } },
}, context, new URL('http://scan.local/api/search?q=70yun.xyz&task_id=task-alpha&limit=10'));
assert.equal(fallback.degraded, false);
assert.equal(fallback.items.length, 1);
assert.equal(fallback.items[0].mapping, 'recent_r2_fallback');
assert.equal(fallback.metadata.fallback_used, true);
assert.equal(fallback.metadata.fallback_docs_checked, 1);
assert.equal(fallback.metadata.fallback_matches, 1);
assert.equal(fallback.metadata.indexing_state, 'recent_fallback');
assert.equal(fallback.metadata.empty_reason, null);

const status = await searchService.getSearchStatus(mixedEnv, new URL('http://scan.local/api/admin/search/status?task_id=task-alpha'));
assert.equal(status.enabled, true);
assert.equal(status.binding_present, true);
assert.equal(status.limit_valid, true);
assert.equal(status.info_ok, true);
assert.equal(status.stats_ok, true);
assert.equal(status.artifact_search_docs_count, 2);
assert.equal(status.search_documents.task_id, 'task-alpha');
assert.equal(status.search_documents.state, 'within_indexing_grace');

const failingStatus = await searchService.getSearchStatus({
  ...mixedEnv,
  AI_SEARCH: {
    async search() { return { chunks: [] }; },
    async info() { throw new Error('token=super-secret failed'); },
    async stats() { throw new Error('stats failed'); },
  },
});
assert.equal(failingStatus.info_ok, false);
assert.equal(failingStatus.stats_ok, false);
assert.match(failingStatus.last_error.message, /failed/);
assert.doesNotMatch(JSON.stringify(failingStatus), /super-secret/);

const routeResponse = await searchRoute.handleSearch(new Request('http://scan.local/api/admin/search/status', { headers: { Authorization: 'Bearer dev-token' } }), mixedEnv, new URL('http://scan.local/api/admin/search/status'), '/api/admin/search/status');
assert.equal(routeResponse.status, 200);
const routeBody = await routeResponse.json();
assert.equal(routeBody.data.binding_present, true);
await assert.rejects(
  () => searchRoute.handleSearch(new Request('http://scan.local/api/admin/search/status', { headers: { Authorization: 'Bearer reader-token-fixture' } }), mixedEnv, new URL('http://scan.local/api/admin/search/status'), '/api/admin/search/status'),
  /global admin role required/,
);

console.log(JSON.stringify({
  ok: true,
  cases: ['disabled degraded response', 'enabled missing binding + invalid config', 'mocked info/stats success', 'info/stats failure redaction', 'stale chunk filtered by D1 mapping', 'mixed chunk metadata', 'authorized recent R2 fallback', 'task indexing readiness', 'admin status RBAC'],
  config_errors: missingBindingValidation.errors.map((issue) => ({ code: issue.code, field: issue.field })),
  status: { enabled: status.enabled, binding_present: status.binding_present, info_ok: status.info_ok, stats_ok: status.stats_ok, artifact_search_docs_count: status.artifact_search_docs_count },
  mixed_metadata: mixed.metadata,
  fallback_metadata: fallback.metadata,
  degraded_compatibility: { degraded: disabled.degraded, items_is_array: Array.isArray(disabled.items), error_code: disabled.error.code },
  network: 'not used',
  cloud_credentials: 'not used',
}, null, 2));

class FakeDB {
  constructor(readerHash) {
    this.readerHash = readerHash;
  }
  prepare(sql) {
    return new FakeStatement(sql, this.readerHash);
  }
}

class FakeStatement {
  constructor(sql, readerHash) {
    this.sql = sql;
    this.readerHash = readerHash;
    this.values = [];
  }
  bind(...values) {
    this.values = values;
    return this;
  }
  async first() {
    if (this.sql.includes('COUNT(*) AS count FROM artifacts')) return { count: 2 };
    if (this.sql.includes('FROM api_tokens')) {
      if (this.values[0] !== this.readerHash) return null;
      return { token_id: 'tok_reader', user_id: 'reader-user', token_hash: this.readerHash, scopes_json: '["tasks:read"]', expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null, user_role: 'reader', email: 'reader@example.local' };
    }
    if (this.sql.includes('FROM artifacts ar INNER JOIN tasks t')) {
      const key = this.values[0];
      if (key === 'tenants/default/tasks/task-alpha/search/valid.md') {
        return { artifact_id: 'artifact-alpha', task_id: 'task-alpha', type: 'agent_search_doc', search_r2_key: key, raw_r2_key: 'raw-alpha', created_at: '2026-06-15T00:00:00.000Z' };
      }
      return null;
    }
    throw new Error(`unexpected first SQL: ${this.sql}`);
  }
  async all() {
    if (this.sql.includes('FROM project_memberships')) return { results: [{ project_id: 'project-alpha', role: 'reader' }] };
    throw new Error(`unexpected all SQL: ${this.sql}`);
  }
  async run() {
    return { success: true };
  }
}

function loadTsModule(relativePath, requireMap = {}) {
  const filePath = resolve(root, relativePath);
  const source = readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    exports: module.exports,
    module,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`verify-p1-search-config cannot load ${specifier} from ${relativePath}`);
    },
    Request,
    Response,
    Headers,
    URL,
    crypto,
    TextEncoder,
    Date,
  };
  vm.runInNewContext(compiled, sandbox, { filename: filePath });
  return module.exports;
}
