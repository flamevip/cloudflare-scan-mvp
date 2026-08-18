import { createHash, randomUUID } from 'node:crypto';

const mode = process.argv[2];
if (!['create', 'revoke'].includes(mode)) throw new Error('usage: manage-console-acceptance-identities.mjs create|revoke');

const accountId = required('CLOUDFLARE_ACCOUNT_ID');
const apiToken = required('CLOUDFLARE_API_TOKEN');
const databaseId = required('D1_DATABASE_ID');
const environment = required('CONSOLE_ENVIRONMENT');
const approvalReference = required('APPROVAL_REFERENCE');
const runId = required('GITHUB_RUN_ID').replace(/[^0-9]/g, '');
const projectId = process.env.CONSOLE_PROJECT_ID?.trim() || 'project-default';
const now = new Date().toISOString();

if (!['staging', 'pilot'].includes(environment)) throw new Error('CONSOLE_ENVIRONMENT must be staging or pilot');
if (!/^PILOT-\d{8}-\d{3}$/.test(approvalReference)) throw new Error('approval reference must match PILOT-YYYYMMDD-NNN');

const identities = [
  {
    key: 'reader',
    userId: 'user_console_acceptance_reader',
    tokenId: 'token_console_acceptance_reader',
    token: required('CONSOLE_READER_TOKEN'),
    projectRole: 'reader',
    scopes: ['tasks:read', 'artifacts:read', 'search:read'],
  },
  {
    key: 'operator',
    userId: 'user_console_acceptance_operator',
    tokenId: 'token_console_acceptance_operator',
    token: required('CONSOLE_OPERATOR_TOKEN'),
    projectRole: 'operator',
    scopes: ['tasks:read', 'tasks:write', 'artifacts:read', 'search:read'],
  },
  {
    key: 'project-admin',
    userId: 'user_console_acceptance_project_admin',
    tokenId: 'token_console_acceptance_project_admin',
    token: required('CONSOLE_PROJECT_ADMIN_TOKEN'),
    projectRole: 'admin',
    scopes: ['tasks:read', 'artifacts:read', 'search:read', 'admin:*'],
  },
];
const limitedToken = {
  tokenId: 'token_console_acceptance_limited',
  token: required('CONSOLE_LIMITED_TOKEN'),
  userId: identities[0].userId,
  scopes: ['tasks:read'],
};

if (mode === 'create') {
  const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  for (const identity of identities) {
    await query(`
      INSERT INTO users (id, email, role, status, created_at, updated_at)
      VALUES (?, ?, 'reader', 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        role = 'reader',
        status = 'active',
        updated_at = excluded.updated_at
    `, [identity.userId, `${environment}-${identity.key}@console-acceptance.invalid`, now, now]);
    await query(`
      INSERT INTO project_memberships (id, project_id, user_id, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET
        role = excluded.role,
        status = 'active',
        updated_at = excluded.updated_at
    `, [`pm_console_acceptance_${identity.key.replace('-', '_')}`, projectId, identity.userId, identity.projectRole, now, now]);
    await upsertToken(identity.tokenId, identity.userId, identity.token, identity.scopes, expiresAt);
  }
  await upsertToken(limitedToken.tokenId, limitedToken.userId, limitedToken.token, limitedToken.scopes, expiresAt);
  await audit('console.acceptance.identities.activate', {
    environment, approval_reference: approvalReference, run_id: runId, project_id: projectId,
    users: identities.map((identity) => identity.userId),
  });
  console.log(JSON.stringify({ event: 'console.acceptance.identities_activated', environment, project_id: projectId, expires_at: expiresAt }));
} else {
  for (const tokenId of [...identities.map((identity) => identity.tokenId), limitedToken.tokenId]) {
    await query('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?', [now, now, tokenId]);
  }
  for (const identity of identities) {
    await query('UPDATE project_memberships SET status = \'disabled\', updated_at = ? WHERE project_id = ? AND user_id = ?', [now, projectId, identity.userId]);
    await query('UPDATE users SET status = \'disabled\', updated_at = ? WHERE id = ?', [now, identity.userId]);
  }
  await audit('console.acceptance.identities.revoke', {
    environment, approval_reference: approvalReference, run_id: runId, project_id: projectId,
    users: identities.map((identity) => identity.userId),
  });
  console.log(JSON.stringify({ event: 'console.acceptance.identities_revoked', environment, project_id: projectId }));
}

async function upsertToken(tokenId, userId, rawToken, scopes, expiresAt) {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await query(`
    INSERT INTO api_tokens (
      id, user_id, token_hash, name, scopes_json, expires_at, revoked_at, last_used_at,
      rotated_from_token_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      token_hash = excluded.token_hash,
      name = excluded.name,
      scopes_json = excluded.scopes_json,
      expires_at = excluded.expires_at,
      revoked_at = NULL,
      last_used_at = NULL,
      updated_at = excluded.updated_at
  `, [tokenId, userId, tokenHash, `console acceptance ${approvalReference}`, JSON.stringify(scopes), expiresAt, now, now]);
}

async function audit(action, metadata) {
  await query(`
    INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, project_id, metadata_json, created_at)
    VALUES (?, 'github-actions', ?, 'console_acceptance', ?, ?, ?, ?)
  `, [`audit_${randomUUID()}`, action, `run_${runId}`, projectId, JSON.stringify(metadata), now]);
}

async function query(sql, params) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${response.status}` }] }));
  if (!response.ok || payload.success !== true) {
    const message = payload.errors?.map((error) => error.message).join('; ') || `HTTP ${response.status}`;
    throw new Error(`D1 query failed: ${message}`);
  }
  return payload.result;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
