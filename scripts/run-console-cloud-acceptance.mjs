import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';

const environment = required('CONSOLE_ENVIRONMENT');
const baseUrl = new URL(required('CONSOLE_BASE_URL'));
const reportPath = process.env.ACCEPTANCE_REPORT_PATH?.trim() || 'work/console-cloud-acceptance.json';
const approvalReference = required('APPROVAL_REFERENCE');
const tokens = {
  admin: required('CONSOLE_ADMIN_TOKEN'),
  reader: required('CONSOLE_READER_TOKEN'),
  operator: required('CONSOLE_OPERATOR_TOKEN'),
  projectAdmin: required('CONSOLE_PROJECT_ADMIN_TOKEN'),
  limited: required('CONSOLE_LIMITED_TOKEN'),
};

assert.ok(['staging', 'pilot'].includes(environment), 'CONSOLE_ENVIRONMENT must be staging or pilot');
assert.equal(baseUrl.protocol, 'https:', 'cloud console acceptance requires HTTPS');
assert.match(approvalReference, /^PILOT-\d{8}-\d{3}$/, 'approval reference must match PILOT-YYYYMMDD-NNN');

const report = {
  schema_version: 1,
  event: 'console.cloud.acceptance',
  environment,
  base_url: baseUrl.origin,
  approval_reference: approvalReference,
  started_at: new Date().toISOString(),
  finished_at: null,
  status: 'running',
  source: {
    commit_sha: process.env.GITHUB_SHA ?? null,
    workflow_run_id: process.env.GITHUB_RUN_ID ?? null,
    workflow_run_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
  },
  safeguards: {
    expected_provider_dry_run: true,
    pilot_task_submission_forbidden: true,
    retention_execute_forbidden: true,
    token_values_recorded: false,
  },
  checks: [],
  evidence: {},
};

let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const admin = await runCheck('global_admin_console', () => acceptGlobalAdmin());
  const reader = await runCheck('reader_rbac', () => acceptReader());
  const operator = await runCheck('operator_rbac', () => acceptOperator());
  const projectAdmin = await runCheck('project_admin_rbac', () => acceptProjectAdmin());
  const limited = await runCheck('token_scope_enforcement', () => acceptLimitedScope());
  report.evidence = { admin, reader, operator, project_admin: projectAdmin, limited_scope: limited };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = safeError(error);
  throw new Error(safeError(error));
} finally {
  report.finished_at = new Date().toISOString();
  await browser?.close();
  await saveReport();
}

console.log(JSON.stringify({ event: 'console.cloud.acceptance_passed', environment, checks: report.checks.length, report_path: reportPath }));

async function acceptGlobalAdmin() {
  return withPersona('global_admin', tokens.admin, async ({ page, context, me, projects }) => {
    assert.equal(me.role, 'admin', 'acceptance admin must have the global admin role');
    assert.ok(me.token_type === 'dev_admin' || hasScope(me, 'admin:*'), 'acceptance admin token must include admin:*');
    const projectId = projects[0]?.id;
    assert.ok(projectId, 'global admin must have at least one project');

    const pages = [
      ['/tasks', '扫描任务'], ['/projects', '项目'], ['/search', 'AI Search'],
      ['/admin/users', '用户管理'], ['/admin/tokens', 'API Token'],
      ['/admin/audit', '审计日志'], ['/admin/operations', '运维中心'],
      [`/projects/${encodeURIComponent(projectId)}/members`, '成员'],
      [`/projects/${encodeURIComponent(projectId)}/settings`, '保留策略'],
    ];
    for (const [path, heading] of pages) {
      await goto(page, path);
      await visible(page.getByRole('heading', { name: new RegExp(heading) }).first());
    }

    const taskEvidence = await acceptTaskDetailAndArtifact(page, context, tokens.admin);
    const searchEvidence = await acceptSearch(page);
    const operations = await acceptOperations(page);
    const errorEvidence = await acceptRequestIdError(page);
    return { pages: pages.map(([path]) => path), task: taskEvidence, search: searchEvidence, operations, request_id_error: errorEvidence };
  });
}

async function acceptReader() {
  return withPersona('reader', tokens.reader, async ({ page, me, projects }) => {
    assert.equal(me.role, 'reader');
    assert.equal(me.project_roles[projects[0].id], 'reader');
    await visible(page.getByRole('link', { name: '扫描任务' }));
    await visible(page.getByRole('link', { name: '项目' }));
    await visible(page.getByRole('link', { name: 'AI Search' }));
    assert.equal(await page.getByText('系统管理').count(), 0, 'reader must not see global administration');
    const deepRouteResponse = await page.goto(new URL('/tasks', baseUrl).href, { waitUntil: 'domcontentloaded' });
    assert.equal(deepRouteResponse?.status(), 200, 'deep task route did not return the SPA document');
    assert.match(deepRouteResponse?.headers()['content-type'] ?? '', /text\/html/i, 'deep task route did not return HTML');
    await visible(page.getByRole('heading', { name: '扫描任务' }));
    assert.equal(await page.getByRole('button', { name: /新建任务/ }).count(), 0, 'reader must not create tasks');
    await goto(page, `/projects/${encodeURIComponent(projects[0].id)}/members`);
    assert.equal(new URL(page.url()).pathname, '/forbidden');
    await acceptSearch(page);
    return { role: 'reader', task_create_hidden: true, project_admin_denied: true, search_available: true, deep_route_spa: true };
  });
}

async function acceptOperator() {
  return withPersona('operator', tokens.operator, async ({ page, me, projects }) => {
    assert.equal(me.role, 'reader');
    assert.equal(me.project_roles[projects[0].id], 'operator');
    assert.equal(await page.getByText('系统管理').count(), 0, 'operator must not see global administration');
    await goto(page, '/tasks');
    const createButton = page.getByRole('button', { name: /新建任务/ }).first();
    await visible(createButton);
    await createButton.click();
    await visible(page.getByRole('heading', { name: '创建扫描任务' }));

    if (environment === 'pilot') {
      await visible(page.getByText('Pilot 固定策略'));
      const target = page.getByLabel(/根域名目标/);
      assert.equal(await target.inputValue(), '70yun.xyz');
      const rateLimit = page.getByLabel('Rate limit');
      const timeout = page.getByLabel('总超时（分钟）');
      assert.equal(await rateLimit.inputValue(), '1');
      assert.equal(await timeout.inputValue(), '15');
      assert.equal(await rateLimit.isDisabled(), true);
      assert.equal(await timeout.isDisabled(), true);
      for (const module of ['subdomain', 'http_probe', 'nuclei']) {
        const checkbox = page.getByLabel(module, { exact: true });
        assert.equal(await checkbox.isChecked(), true);
        assert.equal(await checkbox.isDisabled(), true);
      }
      assert.equal(await page.getByText(/Hunter/i).count(), 0, 'pilot UI must not expose Hunter');
      await page.getByRole('button', { name: '取消', exact: true }).click();
      return { role: 'operator', pilot_policy_locked: true, task_submitted: false };
    }

    await page.getByLabel('任务名称').fill(`staging console acceptance ${process.env.GITHUB_RUN_ID ?? 'local'}`);
    await page.getByLabel(/根域名目标/).fill('70yun.xyz');
    const createdResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks');
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    const created = await parseApiResponse(await createdResponse, 200);
    const taskId = created.data?.task_id;
    assert.ok(taskId, 'staging task creation did not return a task_id');
    await page.waitForURL((url) => url.pathname === `/tasks/${taskId}`, { timeout: 30_000 });
    const cancelButton = page.getByRole('button', { name: '取消任务' });
    await visible(cancelButton, 30_000);
    await cancelButton.click();
    await visible(page.getByRole('dialog', { name: '取消扫描任务？' }));
    const cancelResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/tasks/${taskId}/cancel`);
    await page.getByRole('button', { name: '确认取消' }).click();
    const cancelled = await parseApiResponse(await cancelResponse, 200);
    assert.equal(cancelled.data?.status, 'cancelled');
    return { role: 'operator', staging_dry_run_task_id: taskId, cancelled: true };
  });
}

async function acceptProjectAdmin() {
  return withPersona('project_admin', tokens.projectAdmin, async ({ page, me, projects }) => {
    assert.equal(me.role, 'reader');
    assert.equal(me.project_roles[projects[0].id], 'admin');
    assert.ok(hasScope(me, 'admin:*'));
    assert.equal(await page.getByText('系统管理').count(), 0, 'project admin must not see global administration');
    await goto(page, `/projects/${encodeURIComponent(projects[0].id)}/members`);
    await visible(page.getByRole('heading', { name: /成员/ }));
    await visible(page.getByRole('button', { name: '添加成员' }));
    await goto(page, `/projects/${encodeURIComponent(projects[0].id)}/settings`);
    await visible(page.getByRole('heading', { name: /保留策略/ }));
    await visible(page.getByRole('button', { name: '保存保留策略' }));
    await goto(page, '/admin/users');
    assert.equal(new URL(page.url()).pathname, '/forbidden');
    return { role: 'admin', members_page: true, settings_page: true, global_admin_denied: true };
  });
}

async function acceptLimitedScope() {
  return withPersona('limited_scope', tokens.limited, async ({ page, context, me }) => {
    assert.deepEqual(me.token_scopes, ['tasks:read']);
    assert.equal(await page.getByRole('link', { name: 'AI Search' }).count(), 0);
    await goto(page, '/search');
    assert.equal(new URL(page.url()).pathname, '/forbidden');
    const result = await apiRequest(context, tokens.limited, '/api/search?q=70yun.xyz&limit=1', [200, 403]);
    if (environment === 'pilot') {
      assert.equal(result.status, 403, 'pilot must enforce the missing search:read scope');
      assert.match(String(result.envelope.message), /scope required/i);
      assert.ok(result.requestId, 'pilot scope denial must include a Request ID');
    } else {
      assert.equal(result.status, 200, 'staging must remain in scope report-only mode');
    }
    return { token_scopes: ['tasks:read'], ui_search_denied: true, backend_status: result.status, enforcement: environment === 'pilot' ? 'enforce' : 'report' };
  });
}

async function acceptTaskDetailAndArtifact(page, context, token) {
  const fixtureTaskId = `task_console_acceptance_${required('GITHUB_RUN_ID').replace(/[^0-9]/g, '')}`;
  const taskResponse = await apiRequest(context, token, `/api/tasks/${encodeURIComponent(fixtureTaskId)}`, [200]);
  const selected = taskResponse.envelope.data;
  assert.equal(selected?.id, fixtureTaskId, 'cloud environment did not return the current acceptance fixture task');
  const artifactsResponse = await apiRequest(context, token, `/api/artifacts?task_id=${encodeURIComponent(fixtureTaskId)}`, [200]);
  const artifact = artifactsResponse.envelope.data?.items?.[0];
  assert.ok(artifact, 'current acceptance fixture has no downloadable task artifact');
  await goto(page, `/tasks/${encodeURIComponent(selected.id)}`);
  await visible(page.getByText('工具链模块'));
  for (const tab of ['概览', 'Shard', 'Agent Run', 'Assets', 'Findings', 'Artifacts']) {
    await visible(page.getByRole('button', { name: new RegExp(`^${tab}`) }));
  }
  await page.getByRole('button', { name: /^Artifacts/ }).click();
  const rawButton = page.getByRole('button', { name: 'Raw', exact: true }).first();
  await visible(rawButton);
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await rawButton.click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), new RegExp(escapeRegExp(artifact.id)));
  return { task_id: selected.id, status: selected.status, artifact_id: artifact.id, raw_download: true };
}

async function acceptSearch(page) {
  await goto(page, '/search');
  await page.getByLabel('搜索内容').fill('70yun.xyz');
  const searchResponse = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/search');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const parsed = await parseApiResponse(await searchResponse, 200);
  await visible(page.getByText(parsed.data?.degraded ? '搜索服务降级' : '搜索完成'));
  return { degraded: Boolean(parsed.data?.degraded), result_count: parsed.data?.items?.length ?? 0, indexing_state: parsed.data?.metadata?.indexing_state ?? null };
}

async function acceptOperations(page) {
  await goto(page, '/admin/operations');
  await page.getByLabel('执行腾讯只读 Cloud check').check();
  const preflightResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/admin/providers/preflight');
  await page.getByRole('button', { name: '执行 Preflight' }).click();
  const preflight = await parseApiResponse(await preflightResponse, 200);
  const tencent = preflight.data?.dry_run_payloads?.find((item) => item.provider === 'tencent_eks_ci');
  assert.ok(tencent, 'preflight did not include tencent_eks_ci');
  assert.equal(tencent.dry_run_enabled, true, 'Tencent provider must remain in dry-run');
  assert.equal(preflight.data?.cloud_check?.attempted, true);
  assert.equal(preflight.data?.cloud_check?.ok, true);
  assert.equal(Number(preflight.data?.cloud_check?.total_count), 0, 'Tencent preflight observed EKS instances');
  await visible(page.getByText('Preflight result'));

  await page.getByRole('button', { name: '发送 Queue consumer canary' }).click();
  await visible(page.getByRole('dialog', { name: '发送 Queue canary？' }));
  const canaryResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/admin/providers/consumer-canary');
  await page.getByRole('button', { name: '确认发送' }).click();
  const canary = await parseApiResponse(await canaryResponse, 200);
  assert.equal(canary.data?.status, 'queued');

  await page.getByRole('button', { name: '立即执行超时收敛' }).click();
  await visible(page.getByRole('dialog', { name: '立即执行超时收敛？' }));
  const timeoutResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/admin/maintenance/timeouts');
  await page.getByRole('button', { name: '确认执行' }).click();
  const timeout = await parseApiResponse(await timeoutResponse, 200);

  const statusResponse = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/admin/search/status');
  await page.getByRole('button', { name: '读取 AI Search 状态' }).click();
  const searchStatus = await parseApiResponse(await statusResponse, 200);

  const retentionResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/admin/maintenance/retention');
  await page.getByRole('button', { name: '生成 Dry-run 预览' }).click();
  const retention = await parseApiResponse(await retentionResponse, 200);
  assert.equal(retention.request.postDataJSON()?.dry_run, true, 'retention acceptance must be dry-run');
  assert.equal(retention.data?.dry_run, true, 'retention response must confirm dry-run');
  await visible(page.getByText('Retention dry-run'));
  assert.equal(await page.getByRole('button', { name: '执行正式清理' }).isEnabled(), true, 'formal retention button should only enable after preview');

  return {
    provider: 'tencent_eks_ci', provider_dry_run: true, cloud_check_total_count: 0,
    provider_request_id: preflight.data?.cloud_check?.request_id ?? null,
    queue_canary_status: canary.data?.status, queue_canary_nonce: canary.data?.nonce ?? null,
    timeout_sweep: timeout.data ?? {}, search_status: searchStatus.data ?? {}, retention_dry_run: true,
  };
}

async function acceptRequestIdError(page) {
  const missingId = `task_console_acceptance_missing_${process.env.GITHUB_RUN_ID ?? 'local'}`;
  const failedResponses = [];
  const recordFailure = (response) => {
    const url = new URL(response.url());
    if (url.origin === baseUrl.origin && url.pathname.startsWith('/api/') && response.status() >= 400) {
      failedResponses.push({ status: response.status(), requestId: response.headers()['x-request-id'] ?? null });
    }
  };
  page.on('response', recordFailure);
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/tasks/${missingId}`);
  try {
    await goto(page, `/tasks/${missingId}`);
    const response = await responsePromise;
    assert.equal(response.status(), 404);
    assert.ok(response.headers()['x-request-id'], 'error response did not include X-Request-ID');
    const toast = page.locator('.toast').filter({ hasText: 'Request ID' }).first();
    await visible(toast);
    const toastText = await toast.innerText();
    assert.match(toastText, /task not found/i, 'error toast did not display the backend message');
    const displayed = failedResponses.find((failure) => failure.requestId && toastText.includes(failure.requestId));
    assert.ok(displayed, 'error toast Request ID did not match a failed API response');
    return { backend_status: displayed.status, request_id_displayed: true, request_id: displayed.requestId };
  } finally {
    page.off('response', recordFailure);
  }
}

async function withPersona(name, token, acceptance) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const violations = [];
  page.setDefaultTimeout(25_000);
  page.setDefaultNavigationTimeout(45_000);
  page.on('request', (request) => {
    const url = request.url();
    if (Object.values(tokens).some((secret) => url.includes(secret))) violations.push('token appeared in a request URL');
    if (request.method() === 'POST' && new URL(url).pathname === '/api/tasks' && environment === 'pilot') violations.push('pilot task submission was attempted');
    if (request.method() === 'POST' && new URL(url).pathname === '/api/admin/maintenance/retention') {
      try { if (request.postDataJSON()?.dry_run === false) violations.push('formal retention was attempted'); } catch { /* malformed data is handled by the API */ }
    }
  });
  page.on('console', (message) => {
    if (Object.values(tokens).some((secret) => message.text().includes(secret))) violations.push('token appeared in browser console output');
  });

  try {
    await page.goto(new URL('/login', baseUrl).href, { waitUntil: 'domcontentloaded' });
    await visible(page.getByRole('heading', { name: '登录管理台' }));
    await visible(page.getByText(`${environment} · 服务可用`));
    await page.getByLabel('Bearer Token').fill(token);
    await page.getByRole('button', { name: '验证并进入' }).click();
    await page.waitForURL((url) => url.pathname === '/overview', { timeout: 30_000 });
    await visible(page.getByText('安全运行概览'));
    const storage = await page.evaluate((expectedToken) => ({
      sessionMatches: sessionStorage.getItem('cloud-scan.console.token') === expectedToken,
      localToken: localStorage.getItem('cloud-scan.console.token'),
      urlContainsToken: location.href.includes(expectedToken),
      bodyContainsToken: document.body.innerText.includes(expectedToken),
    }), token);
    assert.equal(storage.sessionMatches, true, `${name} token was not stored in the tab session`);
    assert.equal(storage.localToken, null, `${name} token was persisted to localStorage`);
    assert.equal(storage.urlContainsToken, false, `${name} token appeared in the URL`);
    assert.equal(storage.bodyContainsToken, false, `${name} token appeared in page text`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await visible(page.getByText('安全运行概览'));
    const isolatedTab = await context.newPage();
    await isolatedTab.goto(new URL('/overview', baseUrl).href, { waitUntil: 'domcontentloaded' });
    await isolatedTab.waitForURL((url) => url.pathname === '/login' && url.searchParams.get('redirect') === '/overview');
    assert.equal(await isolatedTab.evaluate(() => sessionStorage.getItem('cloud-scan.console.token')), null);
    await isolatedTab.close();

    const auth = await apiRequest(context, token, '/api/auth/me', [200]);
    const projects = await apiRequest(context, token, '/api/projects', [200]);
    const evidence = await acceptance({ page, context, me: auth.envelope.data, projects: projects.envelope.data?.items ?? [] });

    assert.deepEqual(violations, [], `${name} violated console acceptance safeguards`);
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.waitForURL((url) => url.pathname === '/login');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('cloud-scan.console.token')), null);
    return { login: true, refresh_restore: true, isolated_tab_cleared: true, logout_cleared: true, ...evidence };
  } finally {
    await context.close();
  }
}

async function apiRequest(context, token, path, expectedStatuses) {
  const response = await context.request.get(new URL(path, baseUrl).href, { headers: { Authorization: `Bearer ${token}` }, timeout: 30_000 });
  const status = response.status();
  assert.ok(expectedStatuses.includes(status), `${path} returned unexpected status ${status}`);
  const envelope = await response.json();
  return { status, envelope, requestId: response.headers()['x-request-id'] ?? null };
}

async function parseApiResponse(response, expectedStatus) {
  assert.equal(response.status(), expectedStatus, `${new URL(response.url()).pathname} returned ${response.status()}`);
  const envelope = await response.json();
  assert.ok(envelope && typeof envelope === 'object', 'API response envelope is missing');
  assert.ok(Number(envelope.code) < 400, String(envelope.message ?? 'API request failed'));
  return { ...envelope, request: response.request(), requestId: response.headers()['x-request-id'] ?? null };
}

async function goto(page, path) {
  await page.goto(new URL(path, baseUrl).href, { waitUntil: 'domcontentloaded' });
}

async function visible(locator, timeout = 25_000) {
  await locator.waitFor({ state: 'visible', timeout });
}

async function runCheck(name, operation) {
  const startedAt = new Date().toISOString();
  try {
    const evidence = await operation();
    report.checks.push({ name, status: 'passed', started_at: startedAt, finished_at: new Date().toISOString() });
    return evidence;
  } catch (error) {
    report.checks.push({ name, status: 'failed', started_at: startedAt, finished_at: new Date().toISOString(), error: safeError(error) });
    throw error;
  }
}

function hasScope(me, required) {
  const scopes = new Set(me.token_scopes ?? []);
  return me.token_type === 'dev_admin' || scopes.has('*') || scopes.has(required) || (required.startsWith('admin:') && scopes.has('admin:*'));
}

async function saveReport() {
  await mkdir(dirname(reportPath), { recursive: true });
  let serialized = `${JSON.stringify(report, null, 2)}\n`;
  for (const token of Object.values(tokens)) serialized = serialized.split(token).join('[redacted]');
  await writeFile(reportPath, serialized, 'utf8');
}

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const token of Object.values(tokens)) message = message.split(token).join('[redacted]');
  return message.replace(/Bearer\s+[^\s,]+/gi, 'Bearer [redacted]').slice(0, 2000);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
