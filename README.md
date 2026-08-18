# Cloudflare Scan MVP

## 褰撳墠鑵捐 P1 鍩虹嚎锛?026-08-11锛?
- 鏈湴 `wrangler.toml` 鍥哄畾浣跨敤 `mock_inline + dev-token + mock`锛屼笉璋冪敤鑵捐 API銆?- staging/pilot 浣跨敤 `config/wrangler.tencent.template.toml` 鍜屽彈淇濇姢 GitHub Environments锛涗袱濂?Cloudflare 涓庤吘璁綉缁?CAM 璧勬簮鐩镐簰闅旂銆?- D1 褰撳墠 additive migration 涓?`0001`鈥揱0010`锛沗0008` 鍔犲叆绠＄悊銆佷繚鐣欏拰鍙栨秷瀛楁锛宍0009` 鍔犲叆绔炴€佷繚鎶わ紝`0010` 璁板綍姣忔杩愯鐨勮吘璁?EIP ID 涓庡疄闄呭嚭鍙?IP銆?- pilot 鍥哄畾鍗曟巿鏉冩牴鍩熷悕銆佸崟 Agent銆乣rate_limit=1`銆佹渶澶?100 鍊欓€夈€佹渶闀?15 鍒嗛挓銆佹棤 Hunter锛屽苟寮哄埗 `subdomain + http_probe + nuclei`銆?- 鑵捐瀹炰緥缁堟€併€佷富鍔ㄥ彇娑堛€佸績璺宠秴鏃跺拰浠诲姟鎬昏秴鏃堕兘浼氳繘鍏?Delete/瀹氭椂娓呯悊闂幆锛涜繜鍒扮殑 Create 杩斿洖涔熶細閲嶆柊鐧昏骞舵竻鐞嗐€?- 瀹屾暣閮ㄧ讲銆侀獙鏀跺拰鍥炴粴姝ラ浠?`docs/tencent-eks-ci-e2e-runbook.md` 涓哄噯銆備粨搴撳疄鐜颁笉浠ｈ〃鐪熷疄鑵捐 apply銆侀暅鍍忔帹閫佹垨鎺堟潈鍩熷悕鎵弿宸茬粡鎵ц銆?
鏈湴楠屾敹鍛戒护锛?
```bash
npm run typecheck
npm run verify:p0
npm run verify:agent
npm run verify:p1
npm run verify:p1:e2e
npm run verify:web
```

鐙珛鐨?Cloudflare 鎸夐渶鎵弿 MVP 宸ョ▼銆傚綋鍓?Phase 1 鐩爣鏄窇閫氾細

```text
POST /api/tasks -> D1/R2/Queue -> mock agent heartbeat/ingest/complete -> assets/findings/artifacts 鍙煡璇?```

## P1 Tencent pilot implementation

浠撳簱鐜板凡鍖呭惈鑵捐 EKS Container Instances 鐢熶骇璇曡繍琛屾墍闇€鐨勪唬鐮佽矾寰勶細浠诲姟鍙栨秷銆佹寔缁?Agent 蹇冭烦銆佹€绘墽琛屾椂闄愩€丏NS 绉佺綉鍦板潃鎷掔粷銆乀oken/鎴愬憳绠＄悊銆侀」鐩骇淇濈暀绛栫暐銆佸璁′笌杩愮淮鏌ヨ銆佺粓鎬佸疄渚嬫竻鐞嗐€乻taging/pilot 閰嶇疆妯℃澘銆佽吘璁?Terraform 鍜屽彈淇濇姢鐨?GitHub Actions銆?
瀹夊叏杈圭晫锛氶粯璁?`wrangler.toml` 濮嬬粓涓烘湰鍦?`mock_inline`锛涜吘璁厤缃繀椤婚€氳繃 `config/wrangler.tencent.template.toml` 娓叉煋銆俿taging 榛樿涓?application dry-run锛宲ilot 鍙兘鍦ㄦ槑纭壒鍑嗙殑鐩爣銆佺綉缁溿€侀暅鍍忔憳瑕佸拰鎴愭湰涓婇檺涓嬪叧闂?dry-run銆傜湡瀹炲畬鏁村伐鍏烽摼鍥哄畾涓哄崟 Agent銆佹棤 Hunter銆佹棤鐢ㄦ埛妯℃澘锛屽苟浣跨敤闀滃儚鍐呭浐瀹?commit 鐨?Nuclei templates銆?
涓昏鏂板鎺ュ彛锛?
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

榛樿寮€鍙?token锛歚dev-token`銆傝繖鏄粎鐢ㄤ簬鏈湴寮€鍙戠殑鍏煎璺緞锛歐orker 浼氭妸璇?token 鏄犲皠涓?`admin` actor锛屽苟鍙巿鏉冭闂?`DEFAULT_PROJECT_ID`锛堥粯璁?`project-default`锛夈€備笉瑕佸湪鐢熶骇鐜澶嶇敤璇ュ€硷紱鐢熶骇閮ㄧ讲搴旈€氳繃 Wrangler secret 璁剧疆寮洪殢鏈?token 鎴栧悗缁帴鍏ユ寮忚韩浠芥彁渚涙柟銆?
榛樿绉嶅瓙椤圭洰 `project-default` 鐨?`projects.scope_json` 涓?`["example.com"]`銆傚垱寤轰换鍔℃椂锛宍targets` 蹇呴』钀藉湪璇ラ」鐩?allowlist 鍐咃紱Worker 浠嶄細鎷掔粷 private/internal/metadata host銆乺aw IP 鍜?malformed host銆?
Node.js v22.22.3/npm 10.9.8 鐜涓嬪凡楠岃瘉 Wrangler local D1 migration銆乄orker mock-mode smoke銆乤rtifact download銆乤dmin diagnostics銆佹棤 token 鎷掔粷銆乻cope 澶栫洰鏍囨嫆缁濄€俙GET /api/tasks/:id/agent-runs` 涓嶈繑鍥?agent `callback_token`锛涜 token 浠呯敤浜?agent callback 鑳藉姏璁よ瘉锛屼笉搴旀毚闇茬粰鍓嶇鏌ヨ鎺ュ彛銆?
## Historical Cloudflare staging smoke status (2026-06-16; not the isolated P1 staging environment)

The following section records an older mock smoke using migrations through `0006`. It is not evidence that the current `0007`鈥揱0010`, isolated Tencent staging/pilot infrastructure, or live EKS CI acceptance has been deployed.

2026-06-16 宸插湪 Cloudflare account `ee7bb93469d8ee4f1c81c90854d7de47` 鍒涘缓骞堕獙璇?staging 璧勬簮锛?
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

鏈湴 P0 绾€昏緫鏍￠獙锛堜笉闇€瑕?Cloudflare 鍑嵁锛屼笉鍙戣捣鐪熷疄缃戠粶鎵弿锛夛細

```bash
node scripts/verify-p0.mjs
```

璇ヨ剼鏈洰鍓嶆牎楠屽叡浜?contracts 涓殑鐘舵€併€佹ā鍧椼€佸閮ㄦ潵婧愬拰 agent 妯″紡 allowlist/defaults锛涘熀绾跨紪璇戜粛浣跨敤 `node node_modules/typescript/bin/tsc --noEmit --project tsconfig.json`銆?
P1 migration 绾湰鍦版牎楠岋紙涓嶉渶瑕?Cloudflare 鍑嵁锛屼笉渚濊禆 Wrangler锛涗細鍦ㄤ复鏃?sqlite DB 涓婂簲鐢?migrations锛屽苟鍦ㄥ瓨鍦?Miniflare D1 sqlite 鏃跺鍒跺悗楠岃瘉鍗囩骇璺緞锛屼笉浼氫慨鏀瑰師 DB锛夛細

```bash
node scripts/verify-p1-migrations.mjs
```

D1 migration 绛栫暐淇濇寔 additive-only锛氭柊澧炶〃/绱㈠紩鍜?backfill 鍙互閫氳繃鍚庣画 migration 淇锛汥1 杩滅▼鍥炴粴涓嶅仛 destructive 鑷姩鍖栥€傝嫢杩滅▼搴旂敤澶辫触锛屽厛鍋滄閮ㄧ讲锛屼繚鐣欏綋鍓?migration 鏂囦欢锛屼娇鐢?`wrangler d1 execute`/鎺у埗鍙版鏌ュ凡鍒涘缓瀵硅薄锛屽啀鐢ㄦ柊鐨?forward-fix migration 琛ラ綈鎴栫鐢ㄦ柊鍔熻兘寮€鍏炽€傝繙绋嬬幆澧冧粛搴斾娇鐢?Node.js >=22 鐨?Wrangler 鎵ц锛?
```bash
npm run d1:apply:remote
```

鍒涘缓浠诲姟锛?
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

`wrangler.toml` 榛樿 `AGENT_PROVIDER = "mock"` 涓?`MOCK_AGENT_MODE = "inline"`锛屾湰鍦板垱寤轰换鍔″悗浼氳嚜鍔ㄧ敓鎴?mock asset/finding/artifact 骞跺畬鎴愪换鍔°€?
## Minimal web UI

鎵撳紑 `web/index.html`锛屼繚鎸?API Base URL 涓?`http://localhost:8787`銆丄dmin Token 涓?`dev-token`锛屽嵆鍙垱寤轰换鍔°€佹煡鐪?task/shard/agent run銆乤ssets銆乫indings 鍜?artifact 涓嬭浇銆?
## Manual local agent mode

`manual` provider 浠呬繚鐣欎负搴曞眰寮€鍙戝紑鍏炽€傚嚭浜庤兘鍔?Token 瀹夊叏瑕佹眰锛宍GET /api/tasks/:id/agent-runs` 涓嶈繑鍥?`callback_token`锛屽洜姝ゆ櫘閫氱鐞?API 涓嶆敮鎸佷汉宸ラ鍙?Token銆傝浣跨敤榛樿 inline mock 楠岃瘉鏈湴闂幆锛屾垨浣跨敤 Cloud Run銆丄liyun ECI銆乀encent EKS CI 灏?Token 鐩存帴娉ㄥ叆鍙楁帶瀹瑰櫒銆備笉瑕侀€氳繃鏂板鏌ヨ鎺ュ彛銆佹棩蹇楁垨绠＄悊椤甸潰鏆撮湶 Agent callback Token銆?
## Provider auto routing and cost model

`AGENT_PROVIDER=auto` 浼氭牴鎹畝鍗曟垚鏈ā鍨嬪拰鐩爣鍖哄煙鍚彂寮忚嚜鍔ㄩ€夋嫨 external provider銆傜洰鍓嶅€欓€?provider锛?
```text
gcp_cloud_run
aliyun_eci
```

榛樿绛栫暐锛?
```text
AGENT_AUTO_ROUTING_POLICY=region
```

琛屼负锛?
- `.cn` / `.涓浗` / `.鍏徃` / `.缃戠粶` 鐩爣锛氶€夋嫨 `AGENT_AUTO_CN_PROVIDER`锛岄粯璁?`aliyun_eci`
- 鍏朵粬鐩爣锛氶€夋嫨 `AGENT_AUTO_DEFAULT_PROVIDER`锛岄粯璁?`gcp_cloud_run`

涔熷彲浠ュ垏鎹负绾垚鏈紭鍏堬細

```text
AGENT_AUTO_ROUTING_POLICY=lowest_cost
```

鎴愭湰浼扮畻浣跨敤浠ヤ笅鍙橀噺锛?
```text
AGENT_ESTIMATED_DURATION_SECONDS=600
AGENT_CPU=1
AGENT_MEMORY_GIB=0.5
GCP_CLOUD_RUN_VCPU_SECOND_PRICE=0.000018
GCP_CLOUD_RUN_MEMORY_GIB_SECOND_PRICE=0.000002
ALIYUN_ECI_VCPU_SECOND_PRICE=0.0000077
ALIYUN_ECI_MEMORY_GIB_SECOND_PRICE=0.00000096
```

浼扮畻鍏紡锛?
```text
estimated_cost_usd = duration_seconds * (cpu * vcpu_second_price + memory_gib * memory_gib_second_price)
```

鏈湴 dry-run 绀轰緥锛?
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

鍒涘缓 `example.cn` 浠诲姟浼?dry-run 鍒?`aliyun_eci`锛涘垱寤?`example.com` 浠诲姟浼?dry-run 鍒?`gcp_cloud_run`銆傚鏋滆缃?`AGENT_AUTO_ROUTING_POLICY=lowest_cost`锛屽湪榛樿浠锋牸涓嬩細閫夋嫨 `aliyun_eci`銆?
### Auto fallback and max cost

`auto` provider 鏀寔 fallback skeleton锛?
```text
AGENT_AUTO_ENABLE_FALLBACK=true
```

褰撻閫?provider 鍚姩澶辫触鏃讹紝Queue consumer 浼氭寜 auto routing 鐢熸垚鐨勫€欓€夐『搴忓皾璇曚笅涓€涓?provider锛屽苟鎶?fallback 鍘熷洜鍐欏叆 `agent_runs.error_message`銆傛垚鍔?fallback 鍚庯紝`agent_runs.provider`銆乣provider_job_id`銆乣image`銆乣region` 浼氭洿鏂颁负鏈€缁堟垚鍔熷惎鍔ㄧ殑 provider銆?
棰勭畻涓婇檺鍙互閫氳繃鍏ㄥ眬 env 鎴栧崟涓换鍔¤缃細

```text
AGENT_MAX_COST_USD=0.01
```

鎴栬€呭垱寤轰换鍔℃椂浼狅細

```json
{
  "targets": ["example.com"],
  "max_cost_usd": 0.01
}
```

浠诲姟绾?`max_cost_usd` 浼樺厛浜庡叏灞€ `AGENT_MAX_COST_USD`銆傚鏋滄墍鏈夊€欓€?provider 鐨勪及绠楁垚鏈兘瓒呰繃棰勭畻锛屼换鍔′細鍦ㄥ垱寤?shard/agent_run 鍚庤鏍囪涓?`failed`锛屼笉浼氬惎鍔ㄥ閮ㄥ鍣ㄣ€?
Fallback 楠岃瘉绀轰緥锛氭晠鎰忎笉缁?GCP 蹇呴渶閰嶇疆锛岃 `example.com` 棣栭€?`gcp_cloud_run` 澶辫触锛屽啀 fallback 鍒?Aliyun dry-run锛?
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

Budget 楠岃瘉绀轰緥锛氳缃瀬浣庨绠楋紝纭涓嶄細鍚姩 provider锛?
```bash
npx wrangler dev --config wrangler.toml --port 8787 \
  --var AGENT_PROVIDER:auto \
  --var AGENT_AUTO_ROUTING_POLICY:lowest_cost \
  --var AGENT_MAX_COST_USD:0.000001
```

## Cloud Run Jobs provider

瀹屾暣鐪熷疄 GCP 绔埌绔懡浠よ锛歚docs/cloud-run-e2e-runbook.md`銆?
Cloud Run provider 浼氬鐢?`agent/real` 鐨勭幆澧冨彉閲忓悎鍚屻€俉orker 鍦?Queue consumer 涓垱寤?shard銆乤gent_run 鍜?task-bound callback token 鍚庯紝璋冪敤 Cloud Run Jobs `:run` API锛屽苟鎶婁互涓嬬幆澧冨彉閲忔敞鍏ュ埌 Job锛?
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

鏈湴鎴栭厤缃鏌ユ椂寤鸿鍏?dry-run锛屼笉浼氱湡鐨勮皟鐢?Google API锛?
```bash
npx wrangler dev --config wrangler.toml --port 8787 \
  --var AGENT_PROVIDER:gcp_cloud_run \
  --var CLOUD_RUN_DRY_RUN:true \
  --var CALLBACK_BASE_URL:http://localhost:8787 \
  --var GCP_PROJECT_ID:your-gcp-project \
  --var GCP_LOCATION:asia-east1 \
  --var CLOUD_RUN_JOB_NAME:scan-agent-job
```

鐪熷疄璋冪敤鏃讹細

1. 鏋勫缓骞舵帹閫?`agent/real` 闀滃儚銆?2. 鍒涘缓 Cloud Run Job锛岄暅鍍忎娇鐢ㄨ agent image銆?3. 璁剧疆 Worker vars/secrets锛?   - `AGENT_PROVIDER=gcp_cloud_run`
   - `CALLBACK_BASE_URL=https://<worker-domain>`
   - `GCP_PROJECT_ID`
   - `GCP_LOCATION`
   - `CLOUD_RUN_JOB_NAME`
   - `CLOUD_RUN_CONTAINER_NAME`锛堝彲閫夛級
   - `AGENT_SCAN_MODE=mock`锛堥粯璁ゅ畨鍏ㄦā寮忥紱`http_probe`/`real_toolchain` 浠呯敤浜庡凡鎺堟潈鐩爣锛?   - `CLOUD_RUN_DRY_RUN=false`
4. 璁剧疆 Google auth銆備簩閫変竴锛?   - 涓存椂/寮€鍙戯細`GCP_ACCESS_TOKEN` secret銆?   - 鏈嶅姟璐﹀彿锛歚GCP_CLIENT_EMAIL` 鍜?`GCP_PRIVATE_KEY` secrets锛學orker 浼氱敤 service account JWT 鎹㈠彇 Cloud Platform access token銆?
### Cloud Run setup helper scripts

椤圭洰鎻愪緵浜?3 涓?helper scripts銆傚畠浠粯璁ゅ彧浣跨敤 `agent/real` 闀滃儚锛屼笉浼氬惎鐢?subfinder/httpx/nuclei 绛夌湡瀹炴壂鎻忓櫒銆?
1. 鏋勫缓骞舵帹閫?agent image 鍒?Artifact Registry锛?
```bash
GCP_PROJECT_ID=my-project \
GCP_LOCATION=asia-east1 \
npm run cloud-run:build-agent
```

鑴氭湰浼氳緭鍑?image URI锛屼緥濡傦細

```text
asia-east1-docker.pkg.dev/my-project/scan-mvp/scan-agent:v0.1.0
```

2. 鍒涘缓鎴栨洿鏂?Cloud Run Job锛?
```bash
GCP_PROJECT_ID=my-project \
GCP_LOCATION=asia-east1 \
CLOUD_RUN_JOB_NAME=scan-agent-job \
IMAGE_URI=asia-east1-docker.pkg.dev/my-project/scan-mvp/scan-agent:v0.1.0 \
npm run cloud-run:deploy-job
```

3. 鍒涘缓 Worker 鐢ㄦ潵鍚姩 Cloud Run Job 鐨?service account锛屽苟缁欏畠缁戝畾 job-level `roles/run.invoker`锛?
```bash
GCP_PROJECT_ID=my-project \
GCP_LOCATION=asia-east1 \
CLOUD_RUN_JOB_NAME=scan-agent-job \
KEY_FILE=/tmp/scan-mvp-worker-runner-key.json \
npm run cloud-run:create-worker-sa
```

鐒跺悗浠?key file 璁剧疆 Worker secrets銆備笉瑕佹彁浜?key file锛?
```bash
node -e 'const k=require(process.argv[1]); console.log(k.client_email)' /tmp/scan-mvp-worker-runner-key.json | npx wrangler secret put GCP_CLIENT_EMAIL
node -e 'const k=require(process.argv[1]); console.log(k.private_key)' /tmp/scan-mvp-worker-runner-key.json | npx wrangler secret put GCP_PRIVATE_KEY
```

濡傛灉浣跨敤涓存椂 access token锛屼篃鍙互锛?
```bash
gcloud auth print-access-token | npx wrangler secret put GCP_ACCESS_TOKEN
```

### Cloud Run end-to-end verification

閮ㄧ讲 Worker 鍚庯紝鐢ㄧ湡瀹炲叕缃?Worker URL 浣滀负 callback锛?
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

鍒涘缓浠诲姟锛?
```bash
curl -X POST https://<worker-domain>/api/tasks \
  -H "Authorization: Bearer <DEV_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"cloud-run example.com","targets":["example.com"],"modules":["subdomain","http_probe","nuclei"],"max_agents":1,"rate_limit":50,"timeout_minutes":30}'
```

鐒跺悗鏌ョ湅锛?
```bash
curl -H "Authorization: Bearer <DEV_ADMIN_TOKEN>" https://<worker-domain>/api/tasks/{task_id}
curl -H "Authorization: Bearer <DEV_ADMIN_TOKEN>" https://<worker-domain>/api/tasks/{task_id}/agent-runs
curl -H "Authorization: Bearer <DEV_ADMIN_TOKEN>" "https://<worker-domain>/api/assets?task_id={task_id}"
curl -H "Authorization: Bearer <DEV_ADMIN_TOKEN>" "https://<worker-domain>/api/artifacts?task_id={task_id}"
```

Cloud Run Job 鍚姩鎴愬姛鍚庯紝`agent_runs.provider_job_id` 浼氫繚瀛?Google operation name锛泃ask 浼氫繚鎸?`provisioning/starting`锛岀洿鍒?Cloud Run 涓殑 agent 鍥炶皟 heartbeat 鍚庤繘鍏?`running`锛宑omplete 鍚庤繘鍏?`completed`銆?
## Aliyun ECI provider

Aliyun ECI provider 鍜?Cloud Run provider 浣跨敤鍚屼竴濂?agent contract銆俉orker 鍦?Queue consumer 涓垱寤?shard銆乤gent_run 鍜?task-bound callback token 鍚庯紝璋冪敤闃块噷浜?ECI `CreateContainerGroup`锛屽苟鎶婁互涓嬬幆澧冨彉閲忔敞鍏ュ埌瀹瑰櫒锛?
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

鏈湴鎴栭厤缃鏌ユ椂寤鸿鍏?dry-run锛屼笉浼氱湡鐨勮皟鐢ㄩ樋閲屼簯 API锛?
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

鐪熷疄璋冪敤鏃堕渶瑕佽缃?vars/secrets锛?
- `AGENT_PROVIDER=aliyun_eci`
- `CALLBACK_BASE_URL=https://<worker-domain>`
- `AGENT_SCAN_MODE=mock`锛堥粯璁ゅ畨鍏ㄦā寮忥紱`http_probe`/`real_toolchain` 浠呯敤浜庡凡鎺堟潈鐩爣锛?- `ALIYUN_REGION_ID`
- `ALIYUN_SECURITY_GROUP_ID`
- `ALIYUN_VSWITCH_ID`
- `ALIYUN_ECI_IMAGE`
- `ALIYUN_ECI_CONTAINER_NAME=scan-agent`
- `ALIYUN_ECI_CPU=1`
- `ALIYUN_ECI_MEMORY=0.5`
- `ALIYUN_ECI_DRY_RUN=false`
- `ALIYUN_ACCESS_KEY_ID` secret
- `ALIYUN_ACCESS_KEY_SECRET` secret

绀轰緥 secrets锛?
```bash
npx wrangler secret put ALIYUN_ACCESS_KEY_ID
npx wrangler secret put ALIYUN_ACCESS_KEY_SECRET
```

ECI ContainerGroup 鍒涘缓鎴愬姛鍚庯紝`agent_runs.provider_job_id` 浼氫繚瀛?`ContainerGroupId`锛泃ask 浼氫繚鎸?`provisioning/starting`锛岀洿鍒?ECI 涓殑 agent 鍥炶皟 heartbeat 鍚庤繘鍏?`running`锛宑omplete 鍚庤繘鍏?`completed`銆?
## Tencent EKS Container Instances provider

瀹屾暣閰嶇疆銆侀獙璇佸拰鍥炴粴姝ラ瑙侊細`docs/tencent-eks-ci-e2e-runbook.md`銆?
`tencent_eks_ci` 閫氳繃鑵捐浜?TKE OpenAPI 鐨?`CreateEKSContainerInstances` 鍒涘缓涓€涓煭鐢熷懡鍛ㄦ湡瀹瑰櫒瀹炰緥锛屼笉闇€瑕佸垱寤烘垨鏆撮湶鏍囧噯 TKE Kubernetes API Server銆傝 provider 绗竴闃舵浠呮敮鎸佹樉寮忛€夋嫨锛屼笉鍙備笌 `auto` 璺敱鎴?provider fallback銆?
搴旂敤灞?dry-run 榛樿寮€鍚紝涓嶈皟鐢ㄨ吘璁簯 API锛?
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

鏁忔劅閰嶇疆鍙兘浣跨敤 Wrangler secrets锛?
```bash
npx wrangler secret put TENCENT_SECRET_ID
npx wrangler secret put TENCENT_SECRET_KEY
```

鐢熶骇璇曡繍琛屼娇鐢ㄦ垚閮藉湴鍩熺殑鍏紑闃块噷浜?ACR 闀滃儚锛屽洜姝や笉浼氬悜鑵捐璇锋眰闄勫姞 `ImageRegistryCredentials`銆侫CR 鎺ㄩ€佸嚟鎹彧淇濆瓨鍦ㄥ彈淇濇姢鐨?GitHub `agent-image-publish` Environment 涓紝涓嶈繘鍏?Worker銆乀erraform state 鎴?EKS 璇锋眰銆傝姹傚浐瀹氫娇鐢ㄤ竴涓壇鏈€乣RestartPolicy=Never` 鍜?digest-pinned image锛屽苟澶嶇敤鐜版湁 agent callback contract銆?
棣栨鍙戝竷鍓嶏紝鍦?GitHub `agent-image-publish` Environment 涓厤缃?`ALIYUN_ACR_USERNAME` 鍜?`ALIYUN_ACR_PASSWORD` 涓や釜 secrets锛屽苟纭 `70v2ray/scan-agent-cloud` 浠撳簱绫诲瀷涓哄叕寮€銆俙build-agent.yml` 鎺ㄩ€佸苟绛惧悕闀滃儚鍚庝細閫€鍑?ACR 鐧诲綍锛屽啀鍖垮悕璇诲彇璇?digest锛涘尶鍚嶆鏌ュけ璐ユ椂涓嶄細杈撳嚭鎴栨檵绾ч暅鍍忋€?
鑵捐浜戞湭鍦ㄨ Create API 涓褰曢€氱敤 `DryRun` 鍙傛暟锛屽洜姝?`TENCENT_EKS_CI_DRY_RUN=true` 鏄?Worker 渚у畨鍏ㄥ紑鍏炽€傚叧闂畠浼氬垱寤哄彲璁¤垂璧勬簮锛屽繀椤诲崟鐙壒鍑嗐€傜湡瀹炲惎鍔ㄦ垚鍔熷悗锛宍agent_runs.provider_job_id` 淇濆瓨 `EksCiId`锛宍provider_eip_id` 淇濆瓨鑵捐鑷姩鍒涘缓鐨?EIP ID锛圖escribe 宸茶繑鍥炴椂锛夛紝`provider_egress_ip` 淇濆瓨鑵捐 Describe 鎴?Cloudflare `CF-Connecting-IP` 瑙傛祴鍒扮殑瀹為檯鍏綉鍑哄彛銆傚畾鏃舵敹鏁涘拰鍒犻櫎鍓嶄細璇诲彇瀹炰緥瀹瑰櫒鐘舵€佸強 `DescribeEKSContainerInstanceEvent`锛屾妸缁忚繃鎴柇鍜岃劚鏁忕殑鐘舵€併€佸師鍥犮€佹秷鎭€侀€€鍑虹爜鍙婃渶杩戜簨浠朵繚瀛樺埌 `agent_runs.provider_*` 璇婃柇瀛楁锛涗簨浠舵煡璇㈠け璐ヤ笉浼氶樆鏂祫婧愭竻鐞嗐€傝嫢鍙栨秷绔炴€佸彂鐢熷湪 TKE 杩斿洖 EIP 瀛楁涔嬪墠锛屾竻鐞嗕細鍏堥€氳繃 VPC `DescribeAddresses` 鎸?EKS 瀹炰緥 ID 绮剧‘鍙戠幇浠嶇粦瀹氱殑鑷姩 EIP锛屽啀鎵ц鍒犻櫎锛涘彧鏈夊湪鍙栧緱 EIP ID 鎴栧嚭鍙?IP 鍚庢墠浼氱户缁樉寮忛噴鏀惧湴鍧€銆傜粡杩囨湁鐣屽彂鐜伴噸璇曚粛鏃犳硶鍙栧緱韬唤鏃讹紝鏈€鍚庝竴娆℃竻鐞嗕粛璋冪敤甯?`ReleaseAutoCreatedEip=true` 鐨?Delete锛岀敱鑵捐绾ц仈閲婃斁鑷姩 EIP锛岄伩鍏嶆畫鐣欏疄渚嬫寔缁璐广€倀erminal run 浼氭嫆缁濊繜鍒?callback锛屽苟璋冪敤 `DeleteEKSContainerInstances` 涓旇缃?`ReleaseAutoCreatedEip=true`锛涘畬鎴愩€佸け璐ャ€佸彇娑堛€佽秴鏃跺拰杩熷埌 Create 鐨勬竻鐞嗚嫢灏氭湭鏀舵暃锛屼細閫氳繃 `provider.cleanup` Queue 姣?90 绉掗噸璇曪紝鏈€澶氭墽琛?6 娆℃棭鏈熸鏌ワ紝涔嬪悗淇濈暀姣?10 鍒嗛挓 Cron 浣滀负鏈€缁堝厹搴曘€侱elete 杩斿洖鍚庝細鍦ㄩ粯璁?15 绉掔ǔ瀹氱獥鍙ｅ唴鎵ц 4 娆＄簿纭?Describe锛屽彧鏈夋渶鍚庤嚦灏戣繛缁?2 娆＄‘璁ゅ疄渚嬩笉瀛樺湪鎵嶇户缁竻鐞?EIP锛涘崟娆℃殏鏃朵笉鍙涓嶄細鏍囪瀹屾垚锛屽凡鎺ュ彈鍒犻櫎鍚庣殑浼犳挱绛夊緟涔熶笉浼氭秷鑰?5 娆＄湡瀹炴竻鐞嗗け璐ラ搴︺€傛瘡 10 鍒嗛挓鐨勬竻鐞嗕换鍔¤繕浼氭壂鎻忎簯绔?`scan-*` 瀹炰緥锛屾妸浠嶅瓨鍦ㄤ絾 D1 宸查敊璇爣璁板畬鎴愮殑缁堟€佽繍琛岄噸鏂版墦寮€杩涘叆閲嶈瘯銆傚疄渚嬬ǔ瀹氭秷澶卞悗鍐嶉€氳繃 VPC `DescribeAddresses` 绮剧‘鏍稿鏈 EIP锛屽苟瀵逛粛澶勪簬鏈粦瀹氱姸鎬佺殑鍦板潃璋冪敤 `ReleaseAddresses`锛屽彧鏈夊湴鍧€纭涓嶅瓨鍦ㄥ悗鎵嶆爣璁?cleanup 瀹屾垚銆侫CR 鏋勫缓鏄惧紡鍥哄畾涓?`linux/amd64`銆?
寤鸿 CAM 鏈€灏忔潈闄愶細

```text
tke:CreateEKSContainerInstances
tke:DescribeEKSContainerInstanceEvent
tke:DescribeEKSContainerInstances
tke:DeleteEKSContainerInstances
cvm:DescribeAddresses
cvm:ReleaseAddresses
```

缃戠粶浣跨敤鏃犲叆绔欒鍒欑殑闅旂瀛愮綉锛涙瘡娆?Create 鑷姩鍒嗛厤涓€涓嫭绔?EIP锛屼笖鍥哄畾 `Replicas=1`锛屽洜姝ゅ苟鍙戝鍣ㄤ笉鍏变韩鍑哄彛 IP銆傚湴鍧€鍙兘鍦ㄥ垱寤?鍥炶皟鍚庡緱鐭ワ紝宸查噴鏀惧湴鍧€鏈潵浠嶅彲鑳借鑵捐鍦板潃姹犲鐢ㄣ€傞娆?live smoke 鍙厑璁镐竴涓?`mock` 瀹瑰櫒锛沗http_probe` 鍜?`real_toolchain` 浠嶉渶鐙珛鐩爣鎺堟潈銆?
## P1 local hardening

鏈湴鍙獙璇佺殑 P1 鑳藉姏宸茶ˉ榻愶紝浠嶄笉闇€瑕佺湡瀹?Cloudflare/GCP/Aliyun 鍑嵁锛?
```bash
node scripts/verify-p1-migrations.mjs
node scripts/verify-p1-auth.mjs
node scripts/verify-p1-search-config.mjs
node scripts/verify-p1-provider.mjs
node scripts/verify-toolchain.mjs
```

### Auth / RBAC / token lifecycle

`DEV_ADMIN_TOKEN` 浠嶄繚鐣欎负鏈湴鍏煎璺緞锛涚敓浜ц矾寰勫簲浣跨敤 `api_tokens.token_hash` 涓殑 SHA-256 token hash銆乣project_memberships` 涓殑椤圭洰瑙掕壊锛屼互鍙?`users.role` 鐨勫叏灞€瑙掕壊銆傚綋鍓嶆潈闄愯竟鐣岋細

- global admin锛歚POST /api/admin/maintenance/timeouts`銆乣GET /api/admin/search/status`銆乣POST /api/admin/providers/preflight`
- project write锛歚POST /api/tasks`
- project read锛歵ask/assets/findings/artifacts/search 璇诲彇鎺ュ彛銆乣GET /api/projects`銆乣GET /api/auth/me`

Token 鏀寔 `expires_at`銆乣revoked_at`銆乣last_used_at` 鍜?`scopes_json`銆傛湰鍦?verifier 瑕嗙洊 dev-token銆乬lobal admin銆乸roject operator銆乺eader銆乪xpired/revoked/unknown token 鍜?cross-project denial銆?
### AI Search diagnostics

`GET /api/admin/search/status` 杩斿洖闈炴晱鎰熻瘖鏂細enabled/binding 鐘舵€併€乴imit 鏈夋晥鎬с€乮nfo/stats 璋冪敤缁撴灉銆乻earch doc 鏁伴噺銆佹渶鏂版枃妗ｅ勾榫勫拰 config validation銆傚彲浼犲叆 `task_id` 鏌ョ湅鎸囧畾浠诲姟澶勪簬 `no_documents`銆乣within_indexing_grace` 鎴?`indexing_grace_elapsed`銆俙/api/search` 淇濇寔鍘熸湁 degraded response 鍏煎锛屽悓鏃跺鍔犵储寮曠姸鎬併€佺┖缁撴灉鍘熷洜浠ュ強杩戞湡 R2 fallback 缁熻銆俙AI_SEARCH_INDEXING_GRACE_SECONDS` 榛樿 900 绉掞紝浠呯敤浜庤瘖鏂垎绫伙紝涓嶄細寤惰繜 API 鍝嶅簲銆?
`GET /api/admin/operations/summary` 淇濈暀鍘熸湁瀛楁锛屽苟澧炲姞鏈€杩?24 灏忔椂浠诲姟/Agent/Provider 鍒嗗竷銆佸績璺宠繃鏈熴€佷换鍔℃€绘椂闄愯秴鏈熴€佽吘璁疄渚嬫竻鐞嗗緟澶勭悊/澶辫触/閲嶈瘯鑰楀敖銆佹悳绱㈡枃妗ｅ拰鏈€杩戝紓甯稿垪琛ㄣ€俙health` 涓?`ok`銆乣warning` 鎴?`critical`锛宍alerts` 缁欏嚭鍙敤浜庡閮ㄥ憡璀︾殑绋冲畾 code 鍜屾暟閲忋€?
### Provider preflight and retry classification

`POST /api/admin/providers/preflight` 榛樿鍙仛閰嶇疆/璺敱/dry-run payload 棰勬锛屼笉璋冪敤 GCP/Aliyun/Tencent銆侰loud Run/Aliyun/Tencent provider 閿欒琚垎绫讳负 `config_missing`銆乣auth_failed`銆乣validation`銆乣rate_limited`銆乣transient` 鎴?`unknown`锛孮ueue launch failure 浼氭寜鍒嗙被鍐冲畾鏄惁杩涘叆 bounded retry锛涚己閰嶇疆/璁よ瘉/鏍￠獙閿欒涓嶅啀鏃犳剰涔夐噸璇曘€?
### Toolchain provenance

`agent/real/toolchain.json` 鍥哄畾 ProjectDiscovery 宸ュ叿鐗堟湰锛孌ockerfile 涓嶅啀浣跨敤 `@latest` 瀹夎锛歴ubfinder `v2.7.1`銆乭ttpx `v1.6.10`銆乶uclei `v3.3.8`銆俬elper scripts 鏀寔 digest URI銆丼BOM 鍜?cosign dry-run hooks锛?
```bash
DRY_RUN=true GENERATE_SBOM=true SIGN_IMAGE=true VERIFY_SIGNATURE=true \
  GCP_PROJECT_ID=my-project GCP_LOCATION=asia-east1 ./scripts/cloud-run-build-agent.sh

DRY_RUN=true REQUIRE_IMAGE_DIGEST=true VERIFY_SIGNATURE=true \
  GCP_PROJECT_ID=my-project GCP_LOCATION=asia-east1 \
  IMAGE_URI=asia-east1-docker.pkg.dev/my-project/scan-mvp/scan-agent@sha256:... \
  ./scripts/cloud-run-deploy-job.sh
```

鏈湴 SBOM/cosign 楠岃瘉宸插畬鎴愶細`syft v1.45.1` 鍜?`cosign v3.1.1` 宸插畨瑁呭苟鏍￠獙 release checksum锛宍scan-agent:sbom-local` 宸叉瀯寤猴紝鏈湴闀滃儚 SBOM 鍐欏叆 `agent/real/supply-chain/image-sbom.spdx.json`锛屽苟鐢?cosign blob bundle `agent/real/supply-chain/image-sbom.sigstore.json` 楠岃瘉閫氳繃銆傜湡瀹?registry image digest 鐨?`cosign sign`/`cosign verify` 浠嶉渶鍦ㄦ帹閫侀暅鍍忓悗鎵ц锛涢儴缃叉椂寤鸿寮哄埗 `REQUIRE_IMAGE_DIGEST=true`銆?
## P1 security checklist and known limitations

瀹夊叏榛樿鍊硷細

- 鏈湴榛樿 `AGENT_PROVIDER=mock`銆乣MOCK_AGENT_MODE=inline`銆乣AGENT_SCAN_MODE=mock`銆乣HUNTER_ENABLED=false`銆乣AI_SEARCH_ENABLED=false`銆?- `dev-token` 浠呴檺鏈湴寮€鍙戯紱鐢熶骇蹇呴』浣跨敤 secret 鎴栨寮忚韩浠界郴缁熴€?- 浠诲姟 targets 蹇呴』钀藉湪椤圭洰 `scope_json` allowlist 涓紱raw IP銆乵etadata/internal/private-style host 鍜?malformed host 浼氳鎷掔粷銆?- Hunter 浠呬粠宸叉巿鏉?root domain 娲剧敓 query锛屼笉鎺ュ彈鐢ㄦ埛鍘熷 Hunter query銆?- real toolchain 鍊欓€夊悎骞朵細鍐嶆鎸?root targets 杩囨护锛宯uclei 榛樿鎺掗櫎 DoS/brute-force/fuzz/intrusive/destructive tags銆?- `/api/search` 涓嶇洿鎺ヨ繑鍥?AI Search chunks锛涙瘡鏉＄粨鏋滃繀椤绘槧灏勫洖 D1 artifact/task 骞堕€氳繃椤圭洰杩囨护銆?- Queue retry 鍜?heartbeat timeout 閮芥湁涓婇檺锛汣loud Run Job 鑷韩榛樿 `--max-retries 0`锛岀敱 Worker 缁熶竴鍗忚皟銆?
宸茬煡闄愬埗 / P2 寤鸿锛?
- 宸插叿澶?DB-backed API token銆佸垱寤?杞崲/鎾ら攢鍜岄」鐩垚鍛樼鐞?API/椤甸潰锛涗粛涓嶅寘鍚?OIDC銆佸瘑鐮佺櫥褰曟垨娴忚鍣ㄤ細璇濄€?- AI Search binding/API 鍦ㄤ笉鍚岃处鍙风幆澧冨彲鑳戒笉鍚岋紱浠嶉渶鐪熷疄 Cloudflare 璐﹀彿涓殑 live binding/index smoke test銆?- SBOM/cosign hooks 宸插彲 dry-run 楠岃瘉锛涚湡瀹?SBOM 鐢熸垚銆侀暅鍍忕鍚嶅拰绛惧悕鏍￠獙浠嶉渶 registry銆乣syft`銆乣cosign`/OIDC 鐜銆?- D1 migrations 淇濇寔 additive-only锛涜繙绋嬪簲鐢ㄥけ璐ユ椂浣跨敤 forward-fix migration锛屼笉鍋氳嚜鍔?destructive rollback銆?- P2 鍙鍔犲 Agent 鍒嗙墖銆佹洿缁嗙矑搴︾殑 per-module budgets銆佷笁浜戠粺涓€鐢熶骇 SLA 鍜岀嫭绔?indexing dashboard銆?