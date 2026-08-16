import { expect, test, type Page } from '@playwright/test';
import type { AuthContext } from '../../src/api/contracts';

const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data });
const actor: AuthContext = {
  actor_id: 'user_admin', actor_email: 'admin@70yun.xyz', role: 'admin', token_type: 'api_token', token_id: 'token_ui',
  token_scopes: ['tasks:read', 'tasks:write', 'artifacts:read', 'search:read', 'admin:*'], token_expires_at: null,
  memberships: [{ project_id: 'project-default', role: 'owner' }], project_ids: ['project-default'], project_roles: { 'project-default': 'owner' },
};
const project = { id: 'project-default', name: '70yun Pilot', scope_json: '["70yun.xyz"]', membership_role: 'owner', artifact_retention_days: 30, metadata_retention_days: 180, audit_retention_days: 180, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' };
const task = { id: 'task_demo', project_id: 'project-default', name: '70yun.xyz scan', status: 'completed', targets_json: '["70yun.xyz"]', modules_json: '["subdomain","http_probe","nuclei"]', external_sources_json: '[]', target_count: 1, max_agents: 1, rate_limit: 1, timeout_minutes: 15, created_by: 'user_admin', created_at: '2026-08-15T10:00:00Z', updated_at: '2026-08-15T10:05:00Z', asset_count: 4, finding_count: 0, artifact_count: 3 };
const user = { id: 'user_operator', email: 'operator@70yun.xyz', role: 'reader', status: 'active', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:00Z' };
const listedToken = { id: 'token_operator', user_id: user.id, email: user.email, name: 'pilot operator', scopes_json: '["tasks:read","tasks:write"]', expires_at: null, revoked_at: null, created_at: '2026-08-10T00:00:00Z' };

async function mockApi(page: Page, env = 'pilot', auth: AuthContext = actor): Promise<void> {
  await page.route('**/health', (route) => route.fulfill({ contentType: 'application/json', body: envelope({ service: 'scan-mvp-api', env, time: '2026-08-16T00:00:00Z' }) }));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()); const path = url.pathname;
    let data: unknown = {};
    if (path === '/api/auth/me') data = auth;
    else if (path === '/api/projects') data = { items: [project] };
    else if (path === '/api/tasks') data = route.request().method() === 'POST' ? { task_id: 'task_created', status: 'pending' } : { page: 1, page_size: 20, items: [task] };
    else if (path === '/api/tasks/task_demo') data = task;
    else if (path === '/api/tasks/task_created') data = { ...task, id: 'task_created', status: 'pending' };
    else if (path.endsWith('/shards') || path.endsWith('/agent-runs') || path === '/api/assets' || path === '/api/findings' || path === '/api/artifacts') data = { items: [] };
    else if (path === '/api/admin/operations/summary') data = { generated_at: '2026-08-16T00:00:00Z', health: 'ok', window_hours: 24, tasks_by_status: [], tasks_last_24h_by_status: [{ status: 'completed', count: 1 }], agent_runs_last_24h_total: 1, agent_runs_last_24h_failed_or_timeout: 0, deadlettered_tasks: 0, deadlettered_tasks_last_24h: 0, stale_agent_heartbeats: 0, overdue_task_deadlines: 0, provider_cleanup_pending: 0, provider_cleanup_failures: 0, provider_cleanup_exhausted: 0, search_documents_last_24h: 3, alerts: [], recent_incidents: [] };
    else if (path === '/api/search') data = { degraded: false, query: 'login', task_id: null, type: null, items: [], metadata: { indexing_state: 'ready' } };
    else if (path === '/api/admin/users') data = route.request().method() === 'POST' ? user : { page: 1, page_size: 20, items: [user] };
    else if (path === '/api/admin/tokens') data = route.request().method() === 'POST' ? { ...listedToken, id: 'token_created', token: 'scan_created_once' } : { page: 1, page_size: 20, items: [listedToken] };
    else if (path.endsWith('/rotate')) data = { ...listedToken, id: 'token_rotated', token: 'scan_rotated_once', rotated_from_token_id: listedToken.id };
    else if (path.endsWith('/revoke')) data = { id: listedToken.id, revoked_at: '2026-08-16T00:00:00Z' };
    else if (path === '/api/admin/audit-logs') data = { page: 1, page_size: 20, items: [{ id: 'audit_1', actor: actor.actor_id, action: 'task.create', entity_type: 'task', entity_id: task.id, project_id: project.id, metadata_json: '{}', created_at: '2026-08-15T10:00:00Z' }] };
    else if (path === `/api/projects/${project.id}/members`) data = { items: [{ user_id: user.id, email: user.email, global_role: user.role, user_status: user.status, role: 'operator', status: 'active', created_at: user.created_at, updated_at: user.updated_at }] };
    else if (path === `/api/projects/${project.id}/settings`) data = { project_id: project.id };
    else if (path === '/api/admin/providers/preflight') data = { provider: 'tencent_eks_ci', cloud_check: { requested: false, attempted: false }, dry_run_payloads: [] };
    else if (path === '/api/admin/providers/consumer-canary') data = { nonce: 'canary_1', status: 'queued' };
    else if (path === '/api/admin/maintenance/timeouts') data = { timed_out: 0 };
    else if (path === '/api/admin/maintenance/retention') data = { dry_run: route.request().postDataJSON()?.dry_run, artifacts: 0, metadata: 0, audit: 0 };
    else if (path === '/api/admin/search/status') data = { enabled: true, indexing_state: 'ready' };
    await route.fulfill({ contentType: 'application/json', body: envelope(data), headers: { 'X-Request-ID': 'e2e-ray' } });
  });
}

async function clientNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((nextPath) => {
    window.history.pushState({}, '', nextPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('admin logs in, sees RBAC navigation and opens a task', async ({ page }, testInfo) => {
  await mockApi(page); await page.goto('/login');
  await page.getByLabel('Bearer Token').fill('scan_e2e_secret'); await page.getByRole('button', { name: '验证并进入' }).click();
  await expect(page).toHaveURL(/\/overview$/); await expect(page.getByText('安全运行概览')).toBeVisible(); await expect(page.getByText('系统管理')).toBeVisible();
  if (process.env.VISUAL_CAPTURE) await page.screenshot({ path: 'work/console-overview.png', fullPage: true });
  expect(await page.evaluate(() => localStorage.getItem('cloud-scan.console.token'))).toBeNull();
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('link', { name: /扫描任务/ }).click(); await page.getByRole('link', { name: /70yun.xyz scan/ }).click();
  await expect(page.getByText('工具链模块')).toBeVisible(); await page.reload(); await expect(page.getByText('70yun.xyz scan')).toBeVisible();
});

test('pilot create form locks production safety values', async ({ page }) => {
  await mockApi(page); await page.goto('/login'); await page.getByLabel('Bearer Token').fill('scan_e2e_secret'); await page.getByRole('button', { name: '验证并进入' }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await clientNavigate(page, '/tasks'); await page.getByRole('button', { name: /新建任务/ }).click();
  await expect(page.getByText('Pilot 固定策略')).toBeVisible(); await expect(page.getByLabel('Rate limit')).toHaveValue('1'); await expect(page.getByLabel('总超时（分钟）')).toHaveValue('15'); await expect(page.getByLabel('Rate limit')).toBeDisabled();
  if (process.env.VISUAL_CAPTURE) await page.screenshot({ path: 'work/console-task-modal.png', fullPage: true });
  const createRequest = page.waitForRequest((request) => request.url().endsWith('/api/tasks') && request.method() === 'POST');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  const payload = (await createRequest).postDataJSON();
  expect(payload).toMatchObject({
    project_id: 'project-default', targets: ['70yun.xyz'], modules: ['subdomain', 'http_probe', 'nuclei'],
    external_sources: [], max_agents: 1, rate_limit: 1, timeout_minutes: 15,
  });
});

test('reader navigation stays within scope and project role', async ({ page }) => {
  const reader: AuthContext = {
    ...actor, actor_id: 'user_reader', actor_email: 'reader@70yun.xyz', role: 'reader', token_scopes: ['tasks:read'],
    memberships: [{ project_id: project.id, role: 'reader' }], project_roles: { [project.id]: 'reader' },
  };
  await mockApi(page, 'pilot', reader); await page.goto('/login');
  await page.getByLabel('Bearer Token').fill('scan_reader'); await page.getByRole('button', { name: '验证并进入' }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByText('系统管理')).toHaveCount(0); await expect(page.getByRole('link', { name: 'AI Search' })).toHaveCount(0);
  await clientNavigate(page, '/tasks'); await expect(page.getByRole('button', { name: /新建任务/ })).toHaveCount(0);
  await clientNavigate(page, `/projects/${project.id}/members`); await expect(page).toHaveURL(/\/forbidden$/); await expect(page.getByText('当前用户角色或 Token scope 不允许访问此页面。系统不会自动提升权限。')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('cloud-scan.console.token'))).toBe('scan_reader');
});

test('admin management, search and retention flows are available', async ({ page }) => {
  await mockApi(page); await page.goto('/login');
  await page.getByLabel('Bearer Token').fill('scan_admin'); await page.getByRole('button', { name: '验证并进入' }).click();
  await expect(page).toHaveURL(/\/overview$/);

  await clientNavigate(page, '/admin/users'); await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible(); await expect(page.getByText(user.email)).toBeVisible();
  await clientNavigate(page, '/admin/tokens'); await expect(page.getByRole('heading', { name: 'API Token' })).toBeVisible(); await expect(page.getByText(listedToken.name)).toBeVisible();
  await page.getByRole('button', { name: '创建 Token' }).click(); const createTokenDialog = page.locator('.modal-card'); await createTokenDialog.getByLabel('User ID', { exact: true }).fill(user.id); await createTokenDialog.getByLabel('名称', { exact: true }).fill('temporary token'); await createTokenDialog.getByRole('button', { name: '创建 Token', exact: true }).click();
  await expect(page.getByText('scan_created_once')).toBeVisible(); await page.getByRole('button', { name: '我已安全保存' }).click(); await expect(page.getByText('scan_created_once')).toHaveCount(0);

  await clientNavigate(page, '/admin/audit'); await expect(page.getByRole('heading', { name: '审计日志' })).toBeVisible(); await expect(page.getByText('task.create')).toBeVisible();
  await clientNavigate(page, `/projects/${project.id}/members`); await expect(page.getByRole('heading', { name: /成员/ })).toBeVisible(); await expect(page.getByText(user.email)).toBeVisible();
  await clientNavigate(page, `/projects/${project.id}/settings`); await expect(page.getByRole('heading', { name: /保留策略/ })).toBeVisible();

  await clientNavigate(page, '/search'); await page.getByLabel('搜索内容').fill('login'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.getByText('搜索完成')).toBeVisible();
  await clientNavigate(page, '/admin/operations'); const execute = page.getByRole('button', { name: '执行正式清理' }); await expect(execute).toBeDisabled(); await page.getByRole('button', { name: '生成 Dry-run 预览' }).click(); await expect(execute).toBeEnabled();
  await execute.click(); await page.getByLabel('确认词').fill('EXECUTE RETENTION'); const request = page.waitForRequest((item) => item.url().endsWith('/api/admin/maintenance/retention') && item.postDataJSON()?.dry_run === false); await page.getByRole('button', { name: '确认永久清理' }).click(); await request;
});
