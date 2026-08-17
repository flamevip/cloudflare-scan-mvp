# 腾讯云 EKS CI staging / pilot 试运行手册

本文只覆盖 `tencent_eks_ci` 单 Agent 主路径。它调用腾讯 TKE OpenAPI 的 `CreateEKSContainerInstances`、`DescribeEKSContainerInstances` 和 `DeleteEKSContainerInstances`，不创建或管理标准 TKE Kubernetes 集群。

## 1. 不可跨越的安全边界

- 第一次部署 staging 和 pilot 时必须保持 `TENCENT_EKS_CI_DRY_RUN=true`；此模式不会发送腾讯 API 请求。
- 关闭 dry-run 前，审批记录必须明确：环境、书面授权目标、地域、VPC/子网/安全组、镜像摘要、扫描模式、速率、候选上限、超时、费用上限和清理责任人。
- staging 第一次真实实例只能使用 `SCAN_MODE=mock`、单副本、`RestartPolicy=Never`、5 分钟超时、无 Hunter。
- pilot 只允许一个书面授权根域名，固定 `subdomain + http_probe + nuclei`、`rate_limit=1`、`max_agents=1`、最多 100 个候选、最长 15 分钟、无 Hunter、无用户模板。
- Pilot 工具阶段预算固定为 subfinder 1 分钟、httpx 2 分钟、nuclei 4 分钟，其余任务时间保留给实例准备、入库、终态回调和清理；Nuclei 只运行镜像中固定 commit 的低影响 Pilot 模板集。阶段超时记录为 `partial_timeout` 并保留 stdout/stderr，不得因此扩大速率、候选或模板范围。
- 不得执行真实 Terraform apply、关闭 dry-run 或发起授权目标扫描，除非当次操作已获得独立人工审批。
- CAM/Cloudflare 凭据不得进入 Terraform state、源码、命令参数、日志、preflight 输出或扫描产物。

## 2. 环境与职责分离

两套 Cloudflare 资源必须分别创建：Worker、D1、R2、AI Search、主 Queue 和 Dead-letter Queue。腾讯侧 staging/pilot 使用不同 VPC、子网、安全组和 CAM 用户，只共享同一个摘要固定的公开 GHCR 镜像。不存在环境级共享 NAT；每个 EKS CI 自动创建并绑定自己的 EIP。

GitHub Environments：

- `staging`：staging Worker 变量和独立 Cloudflare/Tencent secrets，required reviewers。
- `pilot`：pilot Worker 变量和独立 Cloudflare/Tencent secrets，required reviewers。
- `tencent-infrastructure`：Terraform COS backend 和基础设施凭据，required reviewers。

CAM Access Key 由操作员在 Terraform 之外创建，只写入对应 GitHub Environment 和 Cloudflare Worker secrets。完成清理后才能撤销。

## 3. Terraform 准备

### 3.1 一次性 COS backend bootstrap

`infra/tencent/bootstrap` 创建私有、AES-256 服务端加密、启用版本控制且禁止 Terraform 销毁的 COS bucket。第一次使用本地 state，创建成功后立即把 bootstrap state 迁移到该 bucket；不要从临时 CI runner 执行 bootstrap。

```bash
terraform -chdir=infra/tencent/bootstrap init -backend=false
terraform -chdir=infra/tencent/bootstrap plan -var="state_bucket=<bucket-name-appid>"
terraform -chdir=infra/tencent/bootstrap apply -var="state_bucket=<bucket-name-appid>"
terraform -chdir=infra/tencent/bootstrap init -migrate-state -backend-config=backend.hcl
```

确认 COS 控制台显示：ACL 为 private、服务端加密为 AES256、版本控制已启用。保留 bootstrap state 和 apply 审批记录。

### 3.2 staging/pilot 网络和 CAM

复制 `infra/tencent/backend.hcl.example` 与 `terraform.tfvars.example` 到被忽略的本地文件。先人工创建两个无 Access Key 的 CAM 用户，再执行：

```bash
terraform -chdir=infra/tencent init -backend-config=backend.hcl
terraform -chdir=infra/tencent fmt -check
terraform -chdir=infra/tencent validate
terraform -chdir=infra/tencent plan -out=tfplan
terraform -chdir=infra/tencent apply tfplan
```

完成标准：

- staging/pilot VPC、子网、SG 相互隔离，Terraform 不创建共享 NAT/EIP；
- Create 固定 `AutoCreateEip=true`、`Replicas=1`，Delete 固定 `ReleaseAutoCreatedEip=true`；Delete 后必须经过完整稳定窗口和连续多次精确 Describe 确认实例不存在，随后按本次运行记录的 EIP ID 或出口 IP 调用 VPC Describe 精确核对，只对未绑定的遗留地址执行 `ReleaseAddresses`，并等待地址确认不存在；
- SG 无入站，出站规则按顺序先拒绝 RFC1918、CGNAT、loopback、link-local/metadata，再允许公网；
- Terraform 配置不包含 TCR，镜像由 GitHub Actions 推送到公开 GHCR；
- 两个 CAM 用户只绑定 EKS CI Create/Describe/Delete 与 EIP `cvm:DescribeAddresses`/`cvm:ReleaseAddresses` 策略；腾讯 VPC API 的 EIP 操作在 CAM 中沿用 `cvm` action 前缀；
- 输出的 VPC/subnet/SG ID 分别写入 GitHub Environment variables；
- state 只存在启用加密和版本控制的 COS backend。

## 4. 构建和固定 Agent 镜像

从 GitHub Actions 手动运行 `build-and-sign-agent`。流水线必须：

1. 构建 `agent/real/Dockerfile`；
2. 将 Nuclei templates `v10.2.7` 的 commit `0f569c3724b966c2ba357c1d26a0aa6c041a6af5` 烘焙进镜像；
3. 生成 SPDX JSON SBOM；
4. 用 GitHub OIDC/Cosign 签名并立即验证；
5. 在 Job Summary 输出 `TENCENT_EKS_CI_IMAGE=<repo>:<tag>@sha256:<digest>`。

工作流使用仓库自带的短期 `GITHUB_TOKEN` 向 `ghcr.io/flamevip/cloudflare-scan-mvp-agent` 推送镜像，不保存 registry 长期凭据。首次构建完成后必须在 GitHub Packages 中确认 package 为 public；腾讯 EKS CI 只拉取公开 digest，不接收 GitHub Token。

把同一条 digest URI 写入 staging 和 pilot 的 `TENCENT_EKS_CI_IMAGE`，禁止只填 tag。`TENCENT_EKS_CI_ALLOWED_REGISTRY_HOST` 必须与 URI 的 registry host 完全一致。

## 5. Cloudflare 资源和配置

分别准备 `config/staging.env.example`、`config/pilot.env.example` 中的 GitHub Environment variables。pilot 示例也保持 dry-run；真正关闭由受保护部署工作流的 `enable_live_provider` 输入控制。

每个环境的 GitHub secrets：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
AGENT_TOKEN_SECRET
TENCENT_SECRET_ID
TENCENT_SECRET_KEY
```

`AGENT_TOKEN_SECRET` 使用独立的 256-bit 随机值。公开 GHCR 镜像不需要 registry secret。部署工作流通过 stdin 同步 Worker secrets，不把明文放入命令参数。

第一次运行 `deploy-worker` 时：

- 选择目标 Environment；
- `enable_live_provider=false`；
- `approval_reference` 可留空；
- 工作流先验证渲染结果、应用 additive migrations `0001`–`0010`、部署 Worker，再同步 secrets。

远程 D1 必须确认至少存在 `0007_provider_cleanup.sql`、`0008_p1_pilot.sql` 和 `0009_p1_lifecycle_guards.sql`。

### 5.1 首个管理员 Token

远程配置不保留 `dev-token`。首次初始化可临时设置一个高强度 `DEV_ADMIN_TOKEN` Worker secret，调用管理 API 创建短期全局管理员 API Token，随后立即删除 `DEV_ADMIN_TOKEN` 并重新部署。API Token 明文只在创建响应中出现一次，安全保存后不要写入浏览器存储或日志。

## 6. staging 验收

### 6.1 dry-run 与只读 preflight

以 `enable_live_provider=false` 部署 staging。使用短期管理员 Token 调用：

```http
POST /api/admin/providers/preflight
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "provider": "tencent_eks_ci",
  "targets": ["example.com"],
  "modules": ["http_probe"],
  "timeout_minutes": 5,
  "cloud_check": true
}
```

确认 provider 配置有效、dry-run 为 true、镜像是 digest、replicas=1、restart policy=`Never`，所有 callback/CAM secrets 均被脱敏。只读 cloud check 只能执行有界 Describe，不证明 Create、镜像拉取、调度容量或回调出站能力。

### 6.2 一次真实 mock 容器

审批后重新运行 `deploy-worker`：environment=`staging`、`enable_live_provider=true`、填写审批编号。创建一个 `mock` 任务，固定 `max_agents=1`、`rate_limit=1`、`timeout_minutes=5`。

验收：

1. `agent_runs.provider_job_id` 为一个真实 `eksci-*` ID，`provider_egress_ip` 在首次 callback 后为腾讯公网地址；
2. 收到持续 heartbeat、ingest 和 complete；
3. 任务和 run 进入成功终态；
4. Delete 请求成功后，在一个共享的 10 分钟收敛窗口内确认 D1 cleanup 已完成，并至少连续 3 次 Describe 确认实例数为 0；该窗口覆盖腾讯异步删除传播和一次 `*/10` Cron 兜底，不得把两类检查串行成 20 分钟；
5. 立即以 `enable_live_provider=false` 重新部署 staging，恢复 dry-run。

## 7. pilot 完整工具链验收

先以 dry-run 部署 pilot，执行 preflight。确认书面授权目标与项目 `scope_json` 一致后，人工批准 `enable_live_provider=true` 并填写审批编号。创建任务：

```json
{
  "project_id": "<pilot-project>",
  "name": "authorized pilot",
  "targets": ["<authorized-root-domain>"],
  "modules": ["subdomain", "http_probe", "nuclei"],
  "external_sources": [],
  "max_agents": 1,
  "rate_limit": 1,
  "timeout_minutes": 15
}
```

Worker 会拒绝非单目标、缺少固定模块、Hunter/外部来源、速率不为 1、超过一个 Agent 或超过 15 分钟的 pilot 任务。Agent 最多处理 100 个候选；DNS 解析到私网、loopback、link-local、metadata、CGNAT/ULA 等地址会被拒绝；httpx 只跟随同主机重定向；Nuclei 禁止自动更新、未签名和用户模板。

完成标准：

- 任务完成，Agent/Shard/Task 终态一致；
- 生成 subfinder/httpx/nuclei 原始工具链产物和搜索文档；
- 产物能由有 `artifacts:read` 的项目成员下载；
- 搜索只能由有 `search:read` 的成员查询，陈旧 AI Search chunk 因无 D1 artifact 映射而被过滤；
- staging 和 pilot AI Search 的 R2 路径过滤器都必须设置包含规则 `**/search/**/*.md`，禁止 raw JSONL、任务配置和目标清单进入索引；
- finding 可以为 0，但工具链原始产物和搜索文档不能为空；
- 腾讯实例完成清理，无遗留 `eksci-*`。

## 8. 取消、总超时与清理重试

### 8.1 主动取消

另建一次 pilot 任务，在运行中由 operator 调用：

```http
POST /api/tasks/<task-id>/cancel
Authorization: Bearer <operator-token-with-tasks:write>
```

确认 task、shard、run 原子进入 `cancelled`；迟到 heartbeat/ingest/complete 返回冲突且不能新增 D1 artifact；实例 Delete 被触发。若取消与 Create 返回竞态，迟到的 `EksCiId` 必须被重新登记并清理。

### 8.2 无回调与总时限

在隔离测试中使用一个不回调的 mock 镜像，或阻断其 callback 出站。确认每 10 分钟 convergence cron：

- 心跳超时会有界重试或进入 dead-letter；
- 即使 heartbeat 持续，超过任务 `timeout_minutes` 也直接进入 timeout，不再重试；
- 终态 Token 被拒绝；
- Delete 失败记录 attempts/error，定时任务最多重试 5 次；
- 定时任务发现云端仍有 `scan-*` 实例、但对应终态 run 已标记 cleanup 完成时，会清除完成标记并重新进入删除重试；
- `GET /api/admin/operations/summary` 显示 timeout、dead-letter 和 cleanup failure 统计。

## 9. 保留策略验收

系统默认 artifact 30 天、metadata 180 天、audit 180 天。项目管理员只能缩短默认值。先预览：

```http
POST /api/admin/maintenance/retention
Authorization: Bearer <admin-token>
Content-Type: application/json

{"dry_run": true}
```

审批后才用 `{"dry_run": false}` 手动执行；共享的 `*/10 * * * *` Cron Trigger 在 UTC 03:00 轮次追加执行每日保留清理，不再单独占用第二个 Cron Trigger。必须验证：

- R2 删除成功后才删除 D1 artifact；失败记录保留供下次重试；
- 有 artifact 的过期 task metadata 不会提前删除；
- 30/180 天边界按严格早于截止时间处理；
- 审计按项目设置清理，系统级审计使用默认 180 天；
- AI Search 暂存的旧 chunk 不会绕过 D1 授权映射。

## 10. 回滚

1. 立即用 `enable_live_provider=false` 重新部署 staging/pilot，停止创建新任务。
2. 保持腾讯 CAM 凭据有效，查询 `provider_cleanup_completed_at IS NULL` 的真实 `EksCiId`。
3. 触发 convergence/cleanup，必要时由审批后的操作员按记录 ID 执行 Delete，并用连续多次 Describe 确认稳定不存在。
4. 确认所有真实实例清理完成后，撤销 CAM Access Key。
5. 保留 D1 `0001`–`0010` additive migrations；失败只使用新的 forward-fix migration，不回滚或重命名字段。
6. 保留审计、SBOM、Cosign 验证结果、镜像 digest、审批记录和 Terraform plan/apply 记录。

官方 API：

- Create: https://cloud.tencent.com/document/api/457/61665
- Describe: https://cloud.tencent.com/document/api/457/61662
- Delete: https://cloud.tencent.com/document/api/457/61664
- TC3 签名: https://cloud.tencent.com/document/product/213/30654
