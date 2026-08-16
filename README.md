# Cloudflare Scan MVP

## 当前腾讯 P1 基线（2026-08-11）

- 本地 `wrangler.toml` 固定使用 `mock_inline + dev-token + mock`，不调用腾讯 API。
- staging/pilot 使用 `config/wrangler.tencent.template.toml` 和受保护 GitHub Environments；两套 Cloudflare 与腾讯网络/CAM 资源相互隔离。
- D1 当前 additive migration 为 `0001`–`0010`；`0008` 加入管理、保留和取消字段，`0009` 加入竞态保护，`0010` 记录每次运行的腾讯 EIP ID 与实际出口 IP。
- pilot 固定单授权根域名、单 Agent、`rate_limit=1`、最多 100 候选、最长 15 分钟、无 Hunter，并强制 `subdomain + http_probe + nuclei`。
- 腾讯实例终态、主动取消、心跳超时和任务总超时都会进入 Delete/定时清理闭环；迟到的 Create 返回也会重新登记并清理。
- 完整部署、验收和回滚步骤以 `docs/tencent-eks-ci-e2e-runbook.md` 为准。仓库实现不代表真实腾讯 apply、镜像推送或授权域名扫描已经执行。

本地验收命令：

```bash
npm run typecheck
npm run verify:p0
npm run verify:agent
npm run verify:p1
npm run verify:p1:e2e
npm run verify:web
```

独立的 Cloudflare 按需扫描 MVP 工程。当前 Phase 1 目标是跑通：

```text
POST /api/tasks -> D1/R2/Queue -> mock agent heartbeat/ingest/complete -> assets/findings/artifacts 可查询
```

## P1 Tencent pilot implementation

仓库现已包含腾讯 EKS Container Instances 生产试运行所需的代码路径：任务取消、持续 Agent 心跳、总执行时限、DNS 私网地址拒绝、Token/成员管理、项目级保留策略、审计与运维查询、终态实例清理、staging/pilot 配置模板、腾讯 Terraform 和受保护的 GitHub Actions。

安全边界：默认 `wrangler.toml` 始终为本地 `mock_inline`；腾讯配置必须通过 `config/wrangler.tencent.template.toml` 渲染。staging 默认为 application dry-run，pilot 只能在明确批准的目标、网络、镜像摘要和成本上限下关闭 dry-run。真实完整工具链固定为单 Agent、无 Hunter、无用户模板，并使用镜像内固定 commit 的 Nuclei templates。

主要新增接口：

```text
POST /api/tasks/:id/cancel
GET|POST /api/admin/users
GET|POST /api/admin/tokens
POST /api/admin/tokens/:id/rotate|revoke
GET|PUT /api/projects/:id/members[/user_id]
PUT /api/projects/:id/settings
GET /api/admin/audit-logs
GET /api/admin/operations/summary
POST /api/admin/maintenance/retention
```

## Local development

```bash
npm install
npm run d1:apply:local
npm run dev
```

默认开发 token：`dev-token`。这是仅用于本地开发的兼容路径：Worker 会把该 token 映射为 `admin` actor，并只授权访问 `DEFAULT_PROJECT_ID`（默认 `project-default`）。不要在生产环境复用该值；生产部署应通过 Wrangler secret 设置强随机 token 或后续接入正式身份提供方。

默认种子项目 `project-default` 的 `projects.scope_json` 为 `["example.com"]`。创建任务时，`targets` 必须落在该项目 allowlist 内；Worker 仍会拒绝 private/internal/metadata host、raw IP 和 malformed host。

Node.js v22.22.3/npm 10.9.8 环境下已验证 Wrangler local D1 migration、Worker mock-mode smoke、artifact download、admin diagnostics、无 token 拒绝、scope 外目标拒绝。`GET /api/tasks/:id/agent-runs` 不返回 agent `callback_token`；该 token 仅用于 agent callback 能力认证，不应暴露给前端查询接口。

## Historical Cloudflare staging smoke status (2026-06-16; not the isolated P1 staging environment)

The following section records an older mock smoke using migrations through `0006`. It is not evidence that the current `0007`–`0010`, isolated Tencent staging/pilot infrastructure, or live EKS CI acceptance has been deployed.

2026-06-16 已在 Cloudflare account `ee7bb93469d8ee4f1c81c90854d7de47` 创建并验证 staging 资源：

- Worker: `cloudflare-scan-mvp-api` at `https://cloudflare-scan-mvp-api.ffffffff.workers.dev`
- D1: `scan_mvp_metadata` (`0c0f3923-d3d6-47eb-8e08-fade83ef08ba`), migrations `0001`-`0006` applied remotely
- R2: `scan-artifacts-dev`
- Queues: `scan-dispatch-dev`, `scan-deadletter-dev`

Deployed staging disables the known local `DEV_ADMIN_TOKEN` value and uses DB-backed API tokens plus `project_memberships`; the agent signing secret is stored as Wrangler secret `AGENT_TOKEN_SECRET`, not in `wrangler.toml`. The generated remote smoke admin token is stored locally in `.remote-admin-token` with `0600` permissions and should not be printed or committed.

Remote mock E2E passed for auth/projects/task create/poll/shards/agent-runs without `callback_token`/assets/findings/artifacts/artifact download/degraded search/admin search status/provider preflight/no-auth 401/out-of-scope 403. Cloudflare AI Search instance `scan-artifacts-search` was then created for R2 `scan-artifacts-dev` with prefix `tenants/default/tasks`, include pattern `**/search/**/*.md`, and metadata fields `task_id`, `shard_id`, `agent_run_id`, `artifact_type`, `search_doc`; Worker was redeployed with `AI_SEARCH_ENABLED=true` and `[[ai_search]]` binding `AI_SEARCH`, and `/api/search` returned non-degraded D1-authorized results. To run remote smoke manually without printing the token:

```bash
BASE="https://cloudflare-scan-mvp-api.ffffffff.workers.dev"
TOKEN="$(tr -d '\n' < .remote-admin-token)"
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/auth/me"
```

本地 P0 纯逻辑校验（不需要 Cloudflare 凭据，不发起真实网络扫描）：

```bash
node scripts/verify-p0.mjs
```

该脚本目前校验共享 contracts 中的状态、模块、外部来源和 agent 模式 allowlist/defaults；基线编译仍使用 `node node_modules/typescript/bin/tsc --noEmit --project tsconfig.json`。

P1 migration 纯本地校验（不需要 Cloudflare 凭据，不依赖 Wrangler；会在临时 sqlite DB 上应用 migrations，并在存在 Miniflare D1 sqlite 时复制后验证升级路径，不会修改原 DB）：

```bash
node scripts/verify-p1-migrations.mjs
```

D1 migration 策略保持 additive-only：新增表/索引和 backfill 可以通过后续 migration 修正；D1 远程回滚不做 destructive 自动化。若远程应用失败，先停止部署，保留当前 migration 文件，使用 `wrangler d1 execute`/控制台检查已创建对象，再用新的 forward-fix migration 补齐或禁用新功能开关。远程环境仍应使用 Node.js >=22 的 Wrangler 执行：

```bash
npm run d1:apply:remote
```

创建任务：

```bash
curl -X POST http://localhost:8787/api/tasks \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"example.com scan","targets":["example.com"],"modules":["subdomain","http_probe","nuclei"],"max_agents":1,"rate_limit":50,"timeout_minutes":30}'
```

## Hunter external source (optional, safe by default)

Hunter enrichment runs in the Worker queue consumer only when a task requests `external_sources: ["hunter"]` and `HUNTER_ENABLED=true`. It derives queries from already-authorized root domains, for example `domain="example.com"`; users cannot submit raw Hunter query syntax in P0. Local defaults keep Hunter disabled, so no external API call or secret is required for tests.

Vars/secrets:

```text
HUNTER_ENABLED=false
HUNTER_API_KEY=<secret; set with wrangler secret put HUNTER_API_KEY>
HUNTER_BASE_URL=https://hunter.qianxin.com/openApi/search
HUNTER_PAGE_SIZE=20
HUNTER_MAX_PAGES=1
HUNTER_MAX_RESULTS=100
HUNTER_TIMEOUT_MS=5000
HUNTER_QUERY_TEMPLATE=domain="{domain}"
```

When enabled, raw responses are written under `tenants/default/tasks/{task_id}/external/hunter/{shard_id}/raw/`, normalized JSONL under `.../normalized.jsonl`, and agent candidates under `tenants/default/tasks/{task_id}/external/hunter/candidates.txt`. Summary rows are upserted into `external_source_results` with `(task_id, provider, asset_key)` uniqueness. Hunter failures are audit-logged with `retryable=true|false` and do not bypass project scope checks.

Example request with Hunter requested but still scoped to the project allowlist:

```bash
curl -X POST http://localhost:8787/api/tasks \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"example.com hunter enrichment","targets":["example.com"],"external_sources":["hunter"],"modules":["subdomain","http_probe"]}'
```

## AI Search (optional)

`/api/search` provides an RBAC-filtered search surface over agent search docs. It requires the same admin bearer token, validates `q` (max 500 chars), optional `task_id`, optional `type`, and `limit` (max 20), then maps AI Search chunks back through D1 artifacts/tasks before returning results. Local defaults return a structured degraded response instead of failing when no binding is configured:

```json
{
  "degraded": true,
  "items": [],
  "error": {
    "code": "ai_search_unconfigured",
    "message": "AI Search binding is not configured or AI_SEARCH_ENABLED is not true"
  }
}
```

Setup notes:

```text
AI_SEARCH_ENABLED=false
AI_SEARCH_LIMIT=10
AI_SEARCH_INDEXING_GRACE_SECONDS=900
# Configure a Cloudflare AI Search binding named AI_SEARCH in wrangler.toml when available.
```

Search docs are stored in R2 with custom metadata (`task_id`, `shard_id`, `agent_run_id`, `artifact_type`, `search_doc=true`) to support R2-backed AI Search indexing. Returned chunks are filtered by project/task access; unauthorized R2 keys are dropped. When a caller supplies `task_id`, the task already has D1 search artifacts, and AI Search has not returned an authorized match yet, the Worker performs an immediate, bounded keyword fallback over at most five recent R2 search documents (maximum 512 KiB each). This fallback happens only after the normal task/project authorization check and is identified by `mapping=recent_r2_fallback`.

## Retry and timeout convergence

Queue/provider retries are bounded by `TASK_MAX_RETRY` (default `1`, meaning at most one retry after the first attempt). Runtime heartbeat timeouts are detected by the scheduled handler and the protected maintenance endpoint:

```bash
curl -X POST http://localhost:8787/api/admin/maintenance/timeouts \
  -H "Authorization: Bearer dev-token"
```

`AGENT_HEARTBEAT_TIMEOUT_SECONDS` defaults to `600`. On launch failure or stale `starting/running` agent runs, the Worker either marks the current run/shard failed or timed out and requeues with `attempt + 1`, or records a deadletter/audit reason and marks the task failed/timeout after retries are exhausted. `TIMEOUT_MINUTES` is injected into the agent and used as the real-toolchain process timeout.

`wrangler.toml` 默认 `AGENT_PROVIDER = "mock"` 且 `MOCK_AGENT_MODE = "inline"`，本地创建任务后会自动生成 mock asset/finding/artifact 并完成任务。

## Minimal web UI

打开 `web/index.html`，保持 API Base URL 为 `http://localhost:8787`、Admin Token 为 `dev-token`，即可创建任务、查看 task/shard/agent run、assets、findings 和 artifact 下载。

## Manual local agent mode

`manual` provider 仅保留为底层开发开关。出于能力 Token 安全要求，`GET /api/tasks/:id/agent-runs` 不返回 `callback_token`，因此普通管理 API 不支持人工领取 Token。请使用默认 inline mock 验证本地闭环，或使用 Cloud Run、Aliyun ECI、Tencent EKS CI 将 Token 直接注入受控容器。不要通过新增查询接口、日志或管理页面暴露 Agent callback Token。

## Provider auto routing and cost model

`AGENT_PROVIDER=auto` 会根据简单成本模型和目标区域启发式自动选择 external provider。目前候选 provider：

```text
gcp_cloud_run
aliyun_eci
```

默认策略：

```text
AGENT_AUTO_ROUTING_POLICY=region
```

行为：

- `.cn` / `.中国` / `.公司` / `.网络` 目标：选择 `AGENT_AUTO_CN_PROVIDER`，默认 `aliyun_eci`
- 其他目标：选择 `AGENT_AUTO_DEFAULT_PROVIDER`，默认 `gcp_cloud_run`

也可以切换为纯成本优先：

```text
AGENT_AUTO_ROUTING_POLICY=lowest_cost
```

成本估算使用以下变量：

```text
AGENT_ESTIMATED_DURATION_SECONDS=600
AGENT_CPU=1
AGENT_MEMORY_GIB=0.5
GCP_CLOUD_RUN_VCPU_SECOND_PRICE=0.000018
GCP_CLOUD_RUN_MEMORY_GIB_SECOND_PRICE=0.000002
ALIYUN_ECI_VCPU_SECOND_PRICE=0.0000077
ALIYUN_ECI_MEMORY_GIB_SECOND_PRICE=0.00000096
```

估算公式：

```text
estimated_cost_usd = duration_seconds * (cpu * vcpu_second_price + memory_gib * memory_gib_second_price)
```

本地 dry-run 示例：

```bash
npx wrangler dev --config wrangler.toml --port 8787 \
  --var AGENT_PROVIDER:auto \
  --var AGENT_AUTO_ROUTING_POLICY:region \
  --var CALLBACK_BASE_URL:http://localhost:8787 \
  --var CLOUD_RUN_DRY_RUN:true \
  --var GCP_PROJECT_ID:scan-mvp-dry-run \
  --var GCP_LOCATION:asia-east1 \
  --var CLOUD_RUN_JOB_NAME:scan-agent-job \
  --var ALIYUN_ECI_DRY_RUN:true \
  --var ALIYUN_REGION_ID:cn-hangzhou \
  --var ALIYUN_SECURITY_GROUP_ID:sg-placeholder \
  --var ALIYUN_VSWITCH_ID:vsw-placeholder \
  --var ALIYUN_ECI_IMAGE:registry.cn-hangzhou.aliyuncs.com/your-namespace/scan-agent:v0.1.0
```

创建 `example.cn` 任务会 dry-run 到 `aliyun_eci`；创建 `example.com` 任务会 dry-run 到 `gcp_cloud_run`。如果设置 `AGENT_AUTO_ROUTING_POLICY=lowest_cost`，在默认价格下会选择 `aliyun_eci`。

### Auto fallback and max cost

`auto` provider 支持 fallback skeleton：

```text
AGENT_AUTO_ENABLE_FALLBACK=true
```

当首选 provider 启动失败时，Queue consumer 会按 auto routing 生成的候选顺序尝试下一个 provider，并把 fallback 原因写入 `agent_runs.error_message`。成功 fallback 后，`agent_runs.provider`、`provider_job_id`、`image`、`region` 会更新为最终成功启动的 provider。

预算上限可以通过全局 env 或单个任务设置：

```text
AGENT_MAX_COST_USD=0.01
```

或者创建任务时传：

```json
{
  "targets": ["example.com"],
  "max_cost_usd": 0.01
}
```

任务级 `max_cost_usd` 优先于全局 `AGENT_MAX_COST_USD`。如果所有候选 provider 的估算成本都超过预算，任务会在创建 shard/agent_run 后被标记为 `failed`，不会启动外部容器。

Fallback 验证示例：故意不给 GCP 必需配置，让 `example.com` 首选 `gcp_cloud_run` 失败，再 fallback 到 Aliyun dry-run：

```bash
npx wrangler dev --config wrangler.toml --port 8787 \
  --var AGENT_PROVIDER:auto \
  --var AGENT_AUTO_ROUTING_POLICY:region \
  --var AGENT_AUTO_ENABLE_FALLBACK:true \
  --var CALLBACK_BASE_URL:http://localhost:8787 \
  --var CLOUD_RUN_DRY_RUN:true \
  --var GCP_PROJECT_ID: \
  --var GCP_LOCATION:asia-east1 \
  --var CLOUD_RUN_JOB_NAME:scan-agent-job \
  --var ALIYUN_ECI_DRY_RUN:true \
  --var ALIYUN_REGION_ID:cn-hangzhou \
  --var ALIYUN_SECURITY_GROUP_ID:sg-placeholder \
  --var ALIYUN_VSWITCH_ID:vsw-placeholder \
  --var ALIYUN_ECI_IMAGE:registry.cn-hangzhou.aliyuncs.com/your-namespace/scan-agent:v0.1.0
```

Budget 验证示例：设置极低预算，确认不会启动 provider：

```bash
npx wrangler dev --config wrangler.toml --port 8787 \
  --var AGENT_PROVIDER:auto \
  --var AGENT_AUTO_ROUTING_POLICY:lowest_cost \
  --var AGENT_MAX_COST_USD:0.000001
```

## Cloud Run Jobs provider

完整真实 GCP 端到端命令见：`docs/cloud-run-e2e-runbook.md`。

Cloud Run provider 会复用 `agent/real` 的环境变量合同。Worker 在 Queue consumer 中创建 shard、agent_run 和 task-bound callback token 后，调用 Cloud Run Jobs `:run` API，并把以下环境变量注入到 Job：

```text
TASK_ID
SHARD_ID
AGENT_RUN_ID
CALLBACK_BASE_URL
CALLBACK_TOKEN
CONFIG_URL
TARGETS_URL
CANDIDATES_URL
MODULES_JSON
RATE_LIMIT
TIMEOUT_MINUTES
SCAN_MODE
```

本地或配置检查时建议先 dry-run，不会真的调用 Google API：

```bash
npx wrangler dev --config wrangler.toml --port 8787 \
  --var AGENT_PROVIDER:gcp_cloud_run \
  --var CLOUD_RUN_DRY_RUN:true \
  --var CALLBACK_BASE_URL:http://localhost:8787 \
  --var GCP_PROJECT_ID:your-gcp-project \
  --var GCP_LOCATION:asia-east1 \
  --var CLOUD_RUN_JOB_NAME:scan-agent-job
```

真实调用时：

1. 构建并推送 `agent/real` 镜像。
2. 创建 Cloud Run Job，镜像使用该 agent image。
3. 设置 Worker vars/secrets：
   - `AGENT_PROVIDER=gcp_cloud_run`
   - `CALLBACK_BASE_URL=https://<worker-domain>`
   - `GCP_PROJECT_ID`
   - `GCP_LOCATION`
   - `CLOUD_RUN_JOB_NAME`
   - `CLOUD_RUN_CONTAINER_NAME`（可选）
   - `AGENT_SCAN_MODE=mock`（默认安全模式；`http_probe`/`real_toolchain` 仅用于已授权目标）
   - `CLOUD_RUN_DRY_RUN=false`
4. 设置 Google auth。二选一：
   - 临时/开发：`GCP_ACCESS_TOKEN` secret。
   - 服务账号：`GCP_CLIENT_EMAIL` 和 `GCP_PRIVATE_KEY` secrets，Worker 会用 service account JWT 换取 Cloud Platform access token。

### Cloud Run setup helper scripts

项目提供了 3 个 helper scripts。它们默认只使用 `agent/real` 镜像，不会启用 subfinder/httpx/nuclei 等真实扫描器。

1. 构建并推送 agent image 到 Artifact Registry：

```bash
GCP_PROJECT_ID=my-project \
GCP_LOCATION=asia-east1 \
npm run cloud-run:build-agent
```

脚本会输出 image URI，例如：

```text
asia-east1-docker.pkg.dev/my-project/scan-mvp/scan-agent:v0.1.0
```

2. 创建或更新 Cloud Run Job：

```bash
GCP_PROJECT_ID=my-project \
GCP_LOCATION=asia-east1 \
CLOUD_RUN_JOB_NAME=scan-agent-job \
IMAGE_URI=asia-east1-docker.pkg.dev/my-project/scan-mvp/scan-agent:v0.1.0 \
npm run cloud-run:deploy-job
```

3. 创建 Worker 用来启动 Cloud Run Job 的 service account，并给它绑定 job-level `roles/run.invoker`：

```bash
GCP_PROJECT_ID=my-project \
GCP_LOCATION=asia-east1 \
CLOUD_RUN_JOB_NAME=scan-agent-job \
KEY_FILE=/tmp/scan-mvp-worker-runner-key.json \
npm run cloud-run:create-worker-sa
```

然后从 key file 设置 Worker secrets。不要提交 key file：

```bash
node -e 'const k=require(process.argv[1]); console.log(k.client_email)' /tmp/scan-mvp-worker-runner-key.json | npx wrangler secret put GCP_CLIENT_EMAIL
node -e 'const k=require(process.argv[1]); console.log(k.private_key)' /tmp/scan-mvp-worker-runner-key.json | npx wrangler secret put GCP_PRIVATE_KEY
```

如果使用临时 access token，也可以：

```bash
gcloud auth print-access-token | npx wrangler secret put GCP_ACCESS_TOKEN
```

### Cloud Run end-to-end verification

部署 Worker 后，用真实公网 Worker URL 作为 callback：

```bash
npx wrangler deploy --config wrangler.toml \
  --var AGENT_PROVIDER:gcp_cloud_run \
  --var CLOUD_RUN_DRY_RUN:false \
  --var CALLBACK_BASE_URL:https://<worker-domain> \
  --var GCP_PROJECT_ID:my-project \
  --var GCP_LOCATION:asia-east1 \
  --var CLOUD_RUN_JOB_NAME:scan-agent-job \
  --var AGENT_SCAN_MODE:mock
```

创建任务：

```bash
curl -X POST https://<worker-domain>/api/tasks \
  -H "Authorization: Bearer <DEV_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"cloud-run example.com","targets":["example.com"],"modules":["subdomain","http_probe","nuclei"],"max_agents":1,"rate_limit":50,"timeout_minutes":30}'
```

然后查看：

```bash
curl -H "Authorization: Bearer <DEV_ADMIN_TOKEN>" https://<worker-domain>/api/tasks/{task_id}
curl -H "Authorization: Bearer <DEV_ADMIN_TOKEN>" https://<worker-domain>/api/tasks/{task_id}/agent-runs
curl -H "Authorization: Bearer <DEV_ADMIN_TOKEN>" "https://<worker-domain>/api/assets?task_id={task_id}"
curl -H "Authorization: Bearer <DEV_ADMIN_TOKEN>" "https://<worker-domain>/api/artifacts?task_id={task_id}"
```

Cloud Run Job 启动成功后，`agent_runs.provider_job_id` 会保存 Google operation name；task 会保持 `provisioning/starting`，直到 Cloud Run 中的 agent 回调 heartbeat 后进入 `running`，complete 后进入 `completed`。

## Aliyun ECI provider

Aliyun ECI provider 和 Cloud Run provider 使用同一套 agent contract。Worker 在 Queue consumer 中创建 shard、agent_run 和 task-bound callback token 后，调用阿里云 ECI `CreateContainerGroup`，并把以下环境变量注入到容器：

```text
TASK_ID
SHARD_ID
AGENT_RUN_ID
CALLBACK_BASE_URL
CALLBACK_TOKEN
CONFIG_URL
TARGETS_URL
CANDIDATES_URL
MODULES_JSON
RATE_LIMIT
TIMEOUT_MINUTES
SCAN_MODE
```

本地或配置检查时建议先 dry-run，不会真的调用阿里云 API：

```bash
npx wrangler dev --config wrangler.toml --port 8787 \
  --var AGENT_PROVIDER:aliyun_eci \
  --var ALIYUN_ECI_DRY_RUN:true \
  --var CALLBACK_BASE_URL:http://localhost:8787 \
  --var ALIYUN_REGION_ID:cn-hangzhou \
  --var ALIYUN_SECURITY_GROUP_ID:sg-placeholder \
  --var ALIYUN_VSWITCH_ID:vsw-placeholder \
  --var ALIYUN_ECI_IMAGE:registry.cn-hangzhou.aliyuncs.com/your-namespace/scan-agent:v0.1.0
```

真实调用时需要设置 vars/secrets：

- `AGENT_PROVIDER=aliyun_eci`
- `CALLBACK_BASE_URL=https://<worker-domain>`
- `AGENT_SCAN_MODE=mock`（默认安全模式；`http_probe`/`real_toolchain` 仅用于已授权目标）
- `ALIYUN_REGION_ID`
- `ALIYUN_SECURITY_GROUP_ID`
- `ALIYUN_VSWITCH_ID`
- `ALIYUN_ECI_IMAGE`
- `ALIYUN_ECI_CONTAINER_NAME=scan-agent`
- `ALIYUN_ECI_CPU=1`
- `ALIYUN_ECI_MEMORY=0.5`
- `ALIYUN_ECI_DRY_RUN=false`
- `ALIYUN_ACCESS_KEY_ID` secret
- `ALIYUN_ACCESS_KEY_SECRET` secret

示例 secrets：

```bash
npx wrangler secret put ALIYUN_ACCESS_KEY_ID
npx wrangler secret put ALIYUN_ACCESS_KEY_SECRET
```

ECI ContainerGroup 创建成功后，`agent_runs.provider_job_id` 会保存 `ContainerGroupId`；task 会保持 `provisioning/starting`，直到 ECI 中的 agent 回调 heartbeat 后进入 `running`，complete 后进入 `completed`。

## Tencent EKS Container Instances provider

完整配置、验证和回滚步骤见：`docs/tencent-eks-ci-e2e-runbook.md`。

`tencent_eks_ci` 通过腾讯云 TKE OpenAPI 的 `CreateEKSContainerInstances` 创建一个短生命周期容器实例，不需要创建或暴露标准 TKE Kubernetes API Server。该 provider 第一阶段仅支持显式选择，不参与 `auto` 路由或 provider fallback。

应用层 dry-run 默认开启，不调用腾讯云 API：

```text
AGENT_PROVIDER=tencent_eks_ci
TENCENT_EKS_CI_DRY_RUN=true
TENCENT_EKS_CI_REGION=ap-chengdu
TENCENT_EKS_CI_VPC_ID=vpc-...
TENCENT_EKS_CI_SUBNET_ID=subnet-...
TENCENT_EKS_CI_SECURITY_GROUP_IDS=sg-...
TENCENT_EKS_CI_IMAGE=registry-intl.cn-chengdu.aliyuncs.com/70v2ray/scan-agent-cloud@sha256:<64-hex>
TENCENT_EKS_CI_ALLOWED_REGISTRY_HOST=registry-intl.cn-chengdu.aliyuncs.com
TENCENT_EKS_CI_CPU=1
TENCENT_EKS_CI_MEMORY=2
TENCENT_EKS_CI_AUTO_CREATE_EIP=true
TENCENT_EKS_CI_EIP_BANDWIDTH_MBPS=5
TENCENT_EKS_CI_EIP_ISP=BGP
```

敏感配置只能使用 Wrangler secrets：

```bash
npx wrangler secret put TENCENT_SECRET_ID
npx wrangler secret put TENCENT_SECRET_KEY
```

生产试运行使用成都地域的公开阿里云 ACR 镜像，因此不会向腾讯请求附加 `ImageRegistryCredentials`。ACR 推送凭据只保存在受保护的 GitHub `agent-image-publish` Environment 中，不进入 Worker、Terraform state 或 EKS 请求。请求固定使用一个副本、`RestartPolicy=Never` 和 digest-pinned image，并复用现有 agent callback contract。

首次发布前，在 GitHub `agent-image-publish` Environment 中配置 `ALIYUN_ACR_USERNAME` 和 `ALIYUN_ACR_PASSWORD` 两个 secrets，并确认 `70v2ray/scan-agent-cloud` 仓库类型为公开。`build-agent.yml` 推送并签名镜像后会退出 ACR 登录，再匿名读取该 digest；匿名检查失败时不会输出或晋级镜像。

腾讯云未在该 Create API 中记录通用 `DryRun` 参数，因此 `TENCENT_EKS_CI_DRY_RUN=true` 是 Worker 侧安全开关。关闭它会创建可计费资源，必须单独批准。真实启动成功后，`agent_runs.provider_job_id` 保存 `EksCiId`，`provider_eip_id` 保存腾讯自动创建的 EIP ID（Describe 已返回时），`provider_egress_ip` 保存腾讯 Describe 或 Cloudflare `CF-Connecting-IP` 观测到的实际公网出口。定时收敛和删除前会读取实例容器状态及 `DescribeEKSContainerInstanceEvent`，把经过截断和脱敏的状态、原因、消息、退出码及最近事件保存到 `agent_runs.provider_*` 诊断字段；事件查询失败不会阻断资源清理，但启用自动 EIP 时必须先取得 EIP ID 或出口 IP 才会删除实例。terminal run 会拒绝迟到 callback，并由定时 cleanup 调用 `DeleteEKSContainerInstances` 且设置 `ReleaseAutoCreatedEip=true`；实例消失后还会通过 VPC `DescribeAddresses` 精确核对本次 EIP，并对仍处于未绑定状态的地址调用 `ReleaseAddresses`，只有地址确认不存在后才标记 cleanup 完成。ACR 构建显式固定为 `linux/amd64`。

建议 CAM 最小权限：

```text
tke:CreateEKSContainerInstances
tke:DescribeEKSContainerInstances
tke:DeleteEKSContainerInstances
```

网络使用无入站规则的隔离子网；每次 Create 自动分配一个独立 EIP，且固定 `Replicas=1`，因此并发容器不共享出口 IP。地址只能在创建/回调后得知，已释放地址未来仍可能被腾讯地址池复用。首次 live smoke 只允许一个 `mock` 容器；`http_probe` 和 `real_toolchain` 仍需独立目标授权。

## P1 local hardening

本地可验证的 P1 能力已补齐，仍不需要真实 Cloudflare/GCP/Aliyun 凭据：

```bash
node scripts/verify-p1-migrations.mjs
node scripts/verify-p1-auth.mjs
node scripts/verify-p1-search-config.mjs
node scripts/verify-p1-provider.mjs
node scripts/verify-toolchain.mjs
```

### Auth / RBAC / token lifecycle

`DEV_ADMIN_TOKEN` 仍保留为本地兼容路径；生产路径应使用 `api_tokens.token_hash` 中的 SHA-256 token hash、`project_memberships` 中的项目角色，以及 `users.role` 的全局角色。当前权限边界：

- global admin：`POST /api/admin/maintenance/timeouts`、`GET /api/admin/search/status`、`POST /api/admin/providers/preflight`
- project write：`POST /api/tasks`
- project read：task/assets/findings/artifacts/search 读取接口、`GET /api/projects`、`GET /api/auth/me`

Token 支持 `expires_at`、`revoked_at`、`last_used_at` 和 `scopes_json`。本地 verifier 覆盖 dev-token、global admin、project operator、reader、expired/revoked/unknown token 和 cross-project denial。

### AI Search diagnostics

`GET /api/admin/search/status` 返回非敏感诊断：enabled/binding 状态、limit 有效性、info/stats 调用结果、search doc 数量、最新文档年龄和 config validation。可传入 `task_id` 查看指定任务处于 `no_documents`、`within_indexing_grace` 或 `indexing_grace_elapsed`。`/api/search` 保持原有 degraded response 兼容，同时增加索引状态、空结果原因以及近期 R2 fallback 统计。`AI_SEARCH_INDEXING_GRACE_SECONDS` 默认 900 秒，仅用于诊断分类，不会延迟 API 响应。

`GET /api/admin/operations/summary` 保留原有字段，并增加最近 24 小时任务/Agent/Provider 分布、心跳过期、任务总时限超期、腾讯实例清理待处理/失败/重试耗尽、搜索文档和最近异常列表。`health` 为 `ok`、`warning` 或 `critical`，`alerts` 给出可用于外部告警的稳定 code 和数量。

### Provider preflight and retry classification

`POST /api/admin/providers/preflight` 默认只做配置/路由/dry-run payload 预检，不调用 GCP/Aliyun/Tencent。Cloud Run/Aliyun/Tencent provider 错误被分类为 `config_missing`、`auth_failed`、`validation`、`rate_limited`、`transient` 或 `unknown`，Queue launch failure 会按分类决定是否进入 bounded retry；缺配置/认证/校验错误不再无意义重试。

### Toolchain provenance

`agent/real/toolchain.json` 固定 ProjectDiscovery 工具版本，Dockerfile 不再使用 `@latest` 安装：subfinder `v2.7.1`、httpx `v1.6.10`、nuclei `v3.3.8`。helper scripts 支持 digest URI、SBOM 和 cosign dry-run hooks：

```bash
DRY_RUN=true GENERATE_SBOM=true SIGN_IMAGE=true VERIFY_SIGNATURE=true \
  GCP_PROJECT_ID=my-project GCP_LOCATION=asia-east1 ./scripts/cloud-run-build-agent.sh

DRY_RUN=true REQUIRE_IMAGE_DIGEST=true VERIFY_SIGNATURE=true \
  GCP_PROJECT_ID=my-project GCP_LOCATION=asia-east1 \
  IMAGE_URI=asia-east1-docker.pkg.dev/my-project/scan-mvp/scan-agent@sha256:... \
  ./scripts/cloud-run-deploy-job.sh
```

本地 SBOM/cosign 验证已完成：`syft v1.45.1` 和 `cosign v3.1.1` 已安装并校验 release checksum，`scan-agent:sbom-local` 已构建，本地镜像 SBOM 写入 `agent/real/supply-chain/image-sbom.spdx.json`，并用 cosign blob bundle `agent/real/supply-chain/image-sbom.sigstore.json` 验证通过。真实 registry image digest 的 `cosign sign`/`cosign verify` 仍需在推送镜像后执行；部署时建议强制 `REQUIRE_IMAGE_DIGEST=true`。

## P1 security checklist and known limitations

安全默认值：

- 本地默认 `AGENT_PROVIDER=mock`、`MOCK_AGENT_MODE=inline`、`AGENT_SCAN_MODE=mock`、`HUNTER_ENABLED=false`、`AI_SEARCH_ENABLED=false`。
- `dev-token` 仅限本地开发；生产必须使用 secret 或正式身份系统。
- 任务 targets 必须落在项目 `scope_json` allowlist 中；raw IP、metadata/internal/private-style host 和 malformed host 会被拒绝。
- Hunter 仅从已授权 root domain 派生 query，不接受用户原始 Hunter query。
- real toolchain 候选合并会再次按 root targets 过滤，nuclei 默认排除 DoS/brute-force/fuzz/intrusive/destructive tags。
- `/api/search` 不直接返回 AI Search chunks；每条结果必须映射回 D1 artifact/task 并通过项目过滤。
- Queue retry 和 heartbeat timeout 都有上限；Cloud Run Job 自身默认 `--max-retries 0`，由 Worker 统一协调。

已知限制 / P2 建议：

- 已具备 DB-backed API token、创建/轮换/撤销和项目成员管理 API/页面；仍不包含 OIDC、密码登录或浏览器会话。
- AI Search binding/API 在不同账号环境可能不同；仍需真实 Cloudflare 账号中的 live binding/index smoke test。
- SBOM/cosign hooks 已可 dry-run 验证；真实 SBOM 生成、镜像签名和签名校验仍需 registry、`syft`、`cosign`/OIDC 环境。
- D1 migrations 保持 additive-only；远程应用失败时使用 forward-fix migration，不做自动 destructive rollback。
- P2 可增加多 Agent 分片、更细粒度的 per-module budgets、三云统一生产 SLA 和独立 indexing dashboard。
