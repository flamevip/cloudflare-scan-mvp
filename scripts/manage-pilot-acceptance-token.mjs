import { createHash, randomUUID } from 'node:crypto';

const mode = process.argv[2];
if (!['create', 'revoke'].includes(mode)) throw new Error('usage: manage-pilot-acceptance-token.mjs create|revoke');

const accountId = required('CLOUDFLARE_ACCOUNT_ID');
const apiToken = required('CLOUDFLARE_API_TOKEN');
const databaseId = required('D1_DATABASE_ID');
const rawToken = required('PILOT_ADMIN_TOKEN');
const approvalReference = required('APPROVAL_REFERENCE');
const runId = required('GITHUB_RUN_ID').replace(/[^0-9]/g, '');
const tokenId = `token_pilot_acceptance_${runId}`;
const now = new Date().toISOString();

if (mode === 'create') {
  if (!/^PILOT-\d{8}-\d{3}$/.test(approvalReference)) throw new Error('approval reference must match PILOT-YYYYMMDD-NNN');
  const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await query(`UPDATE projects SET scope_json = ?, updated_at = ? WHERE id = 'project-default'`, ['["70yun.xyz"]', now]);
  await query(`
    INSERT INTO api_tokens (
      id, user_id, token_hash, name, scopes_json, expires_at, revoked_at, last_used_at,
      rotated_from_token_id, created_at, updated_at
    ) VALUES (?, 'admin', ?, ?, '["*"]', ?, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      token_hash = excluded.token_hash,
      name = excluded.name,
      scopes_json = excluded.scopes_json,
      expires_at = excluded.expires_at,
      revoked_at = NULL,
      updated_at = excluded.updated_at
  `, [tokenId, tokenHash, `pilot acceptance ${approvalReference}`, expiresAt, now, now]);
  await query(`
    INSERT INTO audit_logs (
      id, actor, action, entity_type, entity_id, project_id, metadata_json, created_at
    ) VALUES (?, 'github-actions', 'pilot.acceptance.authorize', 'api_token', ?, 'project-default', ?, ?)
  `, [
    `audit_${randomUUID()}`, tokenId, JSON.stringify({ approval_reference: approvalReference, target: '70yun.xyz', expires_at: expiresAt }), now,
  ]);
  console.log(JSON.stringify({ event: 'pilot.acceptance.token_created', token_id: tokenId, expires_at: expiresAt, target: '70yun.xyz' }));
} else {
  await query(`UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?`, [now, now, tokenId]);
  await query(`
    INSERT INTO audit_logs (
      id, actor, action, entity_type, entity_id, project_id, metadata_json, created_at
    ) VALUES (?, 'github-actions', 'pilot.acceptance.revoke', 'api_token', ?, 'project-default', ?, ?)
  `, [
    `audit_${randomUUID()}`, tokenId, JSON.stringify({ approval_reference: approvalReference, target: '70yun.xyz' }), now,
  ]);
  console.log(JSON.stringify({ event: 'pilot.acceptance.token_revoked', token_id: tokenId }));
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
