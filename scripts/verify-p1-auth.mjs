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

const users = new Map([
  ['admin-user', { id: 'admin-user', email: 'admin@example.local', role: 'admin' }],
  ['operator-user', { id: 'operator-user', email: 'operator@example.local', role: 'reader' }],
  ['reader-user', { id: 'reader-user', email: 'reader@example.local', role: 'reader' }],
]);
const tokens = new Map();
const memberships = new Map([
  ['admin-user', [{ project_id: 'project-alpha', role: 'owner' }, { project_id: 'project-default', role: 'admin' }]],
  ['operator-user', [{ project_id: 'project-alpha', role: 'operator' }]],
  ['reader-user', [{ project_id: 'project-alpha', role: 'reader' }]],
]);
const lastUsedUpdates = [];

class FakeDB {
  prepare(sql) {
    return new FakeStatement(sql);
  }
}

class FakeStatement {
  constructor(sql) {
    this.sql = sql;
    this.values = [];
  }
  bind(...values) {
    this.values = values;
    return this;
  }
  async first() {
    if (this.sql.includes('FROM api_tokens')) {
      const tokenHash = this.values[0];
      const token = tokens.get(tokenHash);
      if (!token) return null;
      const user = users.get(token.user_id);
      if (!user) return null;
      return {
        token_id: token.id,
        user_id: token.user_id,
        token_hash: tokenHash,
        scopes_json: token.scopes_json,
        expires_at: token.expires_at,
        revoked_at: token.revoked_at,
        user_role: user.role,
        email: user.email,
      };
    }
    throw new Error(`unexpected first SQL: ${this.sql}`);
  }
  async all() {
    if (this.sql.includes('FROM project_memberships')) {
      return { results: memberships.get(this.values[0]) ?? [] };
    }
    throw new Error(`unexpected all SQL: ${this.sql}`);
  }
  async run() {
    if (this.sql.includes('UPDATE api_tokens SET last_used_at')) {
      lastUsedUpdates.push(this.values[2]);
      return { success: true };
    }
    throw new Error(`unexpected run SQL: ${this.sql}`);
  }
}

const auth = loadTsModule('worker/src/auth.ts', {
  './response': { HttpError },
  './ids': { newId: (prefix) => `${prefix}_test`, nowIso: () => '2026-06-15T00:00:00.000Z' },
});

const tokenHashes = new Map();
for (const token of ['admin-token-fixture', 'operator-token-fixture', 'reader-token-fixture', 'expired-token-fixture', 'revoked-token-fixture']) {
  tokenHashes.set(token, await auth.hashBearerToken(token));
}

tokens.set(tokenHashes.get('admin-token-fixture'), { id: 'tok_admin', user_id: 'admin-user', scopes_json: '["*"]', expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null });
tokens.set(tokenHashes.get('operator-token-fixture'), { id: 'tok_operator', user_id: 'operator-user', scopes_json: '["tasks:write"]', expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null });
tokens.set(tokenHashes.get('reader-token-fixture'), { id: 'tok_reader', user_id: 'reader-user', scopes_json: '["tasks:read"]', expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null });
tokens.set(tokenHashes.get('expired-token-fixture'), { id: 'tok_expired', user_id: 'reader-user', scopes_json: '[]', expires_at: '2000-01-01T00:00:00.000Z', revoked_at: null });
tokens.set(tokenHashes.get('revoked-token-fixture'), { id: 'tok_revoked', user_id: 'reader-user', scopes_json: '[]', expires_at: '2099-01-01T00:00:00.000Z', revoked_at: '2026-06-15T00:00:00.000Z' });

const env = { DEV_ADMIN_TOKEN: 'dev-token', DEFAULT_PROJECT_ID: 'project-default', DB: new FakeDB() };
const matrix = [];

const dev = await auth.requireAuthContext(req('dev-token'), env);
assert.equal(dev.token_type, 'dev_admin');
assert.equal(dev.role, 'admin');
assert.equal(auth.canAccessProject(dev, 'project-default', 'operator'), true);
matrix.push({ case: 'dev-token', allowed: ['global-admin', 'project-default:write'], denied: [] });

const admin = await auth.requireAuthContext(req('admin-token-fixture'), env);
assert.equal(admin.actor_id, 'admin-user');
assert.equal(admin.token_type, 'api_token');
assert.equal(admin.token_id, 'tok_admin');
assert.deepEqual(JSON.parse(JSON.stringify(admin.token_scopes)), ['*']);
assert.equal(auth.canAccessProject(admin, 'project-alpha', 'operator'), true);
auth.assertGlobalAdmin(admin);
matrix.push({ case: 'api-token global admin', allowed: ['global-admin', 'project-alpha:write'], denied: [] });

const operator = await auth.requireAuthContext(req('operator-token-fixture'), env);
assert.equal(operator.role, 'reader');
assert.equal(auth.canAccessProject(operator, 'project-alpha', 'operator'), true);
assert.throws(() => auth.assertGlobalAdmin(operator), /global admin role required/);
matrix.push({ case: 'api-token project operator', allowed: ['project-alpha:read', 'project-alpha:write'], denied: ['global-admin'] });
assert.equal(auth.hasTokenScope(operator, 'tasks:write'), true);
assert.equal(auth.hasTokenScope(operator, 'tasks:read'), true, 'tasks:write must imply tasks:read');
assert.throws(() => auth.assertTokenScope(operator, { ...env, TOKEN_SCOPE_ENFORCEMENT: 'enforce' }, 'search:read'), /token scope required/);
assert.doesNotThrow(() => auth.assertTokenScope(operator, { ...env, TOKEN_SCOPE_ENFORCEMENT: 'report' }, 'search:read'));

const reader = await auth.requireAuthContext(req('reader-token-fixture'), env);
assert.equal(auth.canAccessProject(reader, 'project-alpha', 'reader'), true);
assert.equal(auth.canAccessProject(reader, 'project-alpha', 'operator'), false);
auth.assertProjectRead(reader, 'project-alpha');
assert.throws(() => auth.assertProjectWrite(reader, 'project-alpha'), /project write denied/);
assert.throws(() => auth.assertProjectRead(reader, 'project-other'), /project access denied/);
matrix.push({ case: 'api-token project reader', allowed: ['project-alpha:read'], denied: ['project-alpha:write', 'project-other:read'] });

await assert.rejects(() => auth.requireAuthContext(req('expired-token-fixture'), env), /token is expired/);
await assert.rejects(() => auth.requireAuthContext(req('revoked-token-fixture'), env), /token is revoked/);
await assert.rejects(() => auth.requireAuthContext(req('unknown-token-fixture'), env), /missing or invalid bearer token/);
await assert.rejects(() => auth.requireAuthContext(new Request('http://scan.local/api/tasks'), env), /missing or invalid bearer token/);
matrix.push({ case: 'invalid token states', allowed: [], denied: ['expired', 'revoked', 'unknown', 'missing'] });

assert.deepEqual(JSON.parse(JSON.stringify(auth.projectFilter(reader, 't'))), { sql: 't.project_id IN (?)', bindings: ['project-alpha'] });
assert.ok(lastUsedUpdates.includes('tok_admin'));
assert.ok(lastUsedUpdates.includes('tok_operator'));
assert.ok(lastUsedUpdates.includes('tok_reader'));
assert.ok(!lastUsedUpdates.includes('tok_expired'));

const taskServiceSource = readFileSync(resolve(root, 'worker/src/services/task-service.ts'), 'utf8');
const listAgentRunsSource = taskServiceSource.match(/export async function listAgentRuns[\s\S]*?\n}\n/)?.[0] ?? '';
assert.ok(listAgentRunsSource, 'listAgentRuns function must exist');
assert.doesNotMatch(listAgentRunsSource, /SELECT\s+\*\s+FROM\s+agent_runs/i, 'agent run list must not expose all columns');
assert.doesNotMatch(listAgentRunsSource, /callback_token/i, 'agent run list must not expose callback_token');

const agentTokenService = loadTsModule('worker/src/services/agent-token.ts', {
  '../auth': { bearerToken: auth.bearerToken },
  '../response': { HttpError },
});
let agentRunStatus = 'starting';
const agentEnv = {
  AGENT_TOKEN_SECRET: 'agent-secret-fixture',
  DB: {
    prepare: () => ({
      bind: () => ({ first: async () => ({ status: agentRunStatus }) }),
    }),
  },
};
const callbackToken = await agentTokenService.createAgentToken(agentEnv, { task_id: 'task_fixture', shard_id: 'shard_fixture', agent_run_id: 'run_fixture' }, 900);
const activeIdentity = await agentTokenService.requireAgentIdentity(reqFor('/api/agent/config', callbackToken), agentEnv);
assert.equal(activeIdentity.agent_run_id, 'run_fixture');
agentRunStatus = 'success';
await assert.rejects(() => agentTokenService.requireAgentIdentity(reqFor('/api/agent/heartbeat', callbackToken), agentEnv), /terminal or superseded/);
assert.equal(agentTokenService.agentTokenTtlSeconds(5), 900);
assert.equal(agentTokenService.agentTokenTtlSeconds(30), 2400);
const agentTokenSource = readFileSync(resolve(root, 'worker/src/services/agent-token.ts'), 'utf8');
assert.match(agentTokenSource, /catch\s*\{\s*throw new HttpError\(401, 'invalid agent token payload'\)/, 'malformed agent token payload must be converted to 401');

console.log(JSON.stringify({
  ok: true,
  matrix,
  token_storage: 'sha256 hash lookup only; raw fixture tokens are not stored in fake DB rows',
  scope_enforcement: ['report allows with warning', 'enforce rejects missing scope', 'tasks:write implies tasks:read'],
  last_used_updates: lastUsedUpdates,
  route_permissions: {
    global_admin: ['POST /api/admin/maintenance/timeouts'],
    project_write: ['POST /api/tasks'],
    project_read: ['GET /api/tasks', 'GET /api/tasks/:id', 'GET /api/tasks/:id/shards', 'GET /api/tasks/:id/agent-runs', 'GET /api/assets', 'GET /api/findings', 'GET /api/artifacts', 'GET /api/artifacts/:id/download-url', 'GET /api/artifacts/:id/download', 'GET /api/search', 'GET /api/projects', 'GET /api/auth/me'],
  },
  dev_token_compatibility: { actor_id: dev.actor_id, project_ids: dev.project_ids, project_role: dev.project_roles['project-default'] },
  network: 'not used',
  cloud_credentials: 'not used',
}, null, 2));

function req(token) {
  return reqFor('/api/tasks', token);
}

function reqFor(path, token) {
  return new Request(`http://scan.local${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

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
      throw new Error(`verify-p1-auth cannot load ${specifier} from ${relativePath}`);
    },
    Request,
    URL,
    crypto,
    TextEncoder,
    Date,
    btoa,
    atob,
  };
  vm.runInNewContext(compiled, sandbox, { filename: filePath });
  return module.exports;
}
