# Cloud Run Jobs Provider End-to-End Runbook

This runbook verifies the real Cloud Run Jobs provider path:

```text
Worker task create -> Queue consumer -> Cloud Run Jobs :run -> scan-agent callback -> task completed
```

Keep the first real run in `AGENT_SCAN_MODE=mock`. Do not enable `http_probe` or `real_toolchain` unless the target is explicitly authorized and toolchain rate/timeout limits are understood.

## 0. Required local tools

```bash
gcloud --version
docker --version
node --version
npm --version
```

If `gcloud` is missing, install Google Cloud CLI first:

```bash
# Debian/Ubuntu quick path. Use your platform-specific installer if different.
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg

echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
  | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list

sudo apt-get update
sudo apt-get install -y google-cloud-cli
```

## 1. Set parameters

Replace these values before running the rest:

```bash
export GCP_PROJECT_ID="my-gcp-project"
export GCP_LOCATION="asia-east1"
export CLOUD_RUN_JOB_NAME="scan-agent-job"
export ARTIFACT_REPOSITORY="scan-mvp"
export IMAGE_NAME="scan-agent"
export IMAGE_TAG="v0.1.0"
export WORKER_NAME="cloudflare-scan-mvp-api"
export WORKER_DOMAIN="https://cloudflare-scan-mvp-api.<your-subdomain>.workers.dev"
export DEV_ADMIN_TOKEN_VALUE="replace-with-a-long-random-admin-token"
export AGENT_TOKEN_SECRET_VALUE="replace-with-a-long-random-agent-secret"
```

Generate secrets if needed:

```bash
openssl rand -hex 32
```

## 2. Authenticate GCP and Cloudflare

```bash
gcloud auth login
gcloud config set project "$GCP_PROJECT_ID"
gcloud auth configure-docker "${GCP_LOCATION}-docker.pkg.dev" --quiet

cd /root/scan/cloudflare-scan-mvp
npx wrangler login
```

## 3. Prepare Cloudflare remote resources

Create D1, R2, and Queues if they do not already exist:

```bash
cd /root/scan/cloudflare-scan-mvp

npx wrangler d1 create scan_mvp_metadata
npx wrangler r2 bucket create scan-artifacts-dev
npx wrangler queues create scan-dispatch-dev
npx wrangler queues create scan-deadletter-dev
```

Copy the `database_id` returned by `wrangler d1 create` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "scan_mvp_metadata"
database_id = "<real-d1-database-id>"
migrations_dir = "migrations/d1"
```

Apply remote D1 migrations:

```bash
npx wrangler d1 migrations apply scan_mvp_metadata --remote --config wrangler.toml
```

## 4. Build and push the agent image

```bash
cd /root/scan/cloudflare-scan-mvp

GCP_PROJECT_ID="$GCP_PROJECT_ID" \
GCP_LOCATION="$GCP_LOCATION" \
ARTIFACT_REPOSITORY="$ARTIFACT_REPOSITORY" \
IMAGE_NAME="$IMAGE_NAME" \
IMAGE_TAG="$IMAGE_TAG" \
npm run cloud-run:build-agent
```

Set the image URI:

```bash
export IMAGE_URI="${GCP_LOCATION}-docker.pkg.dev/${GCP_PROJECT_ID}/${ARTIFACT_REPOSITORY}/${IMAGE_NAME}:${IMAGE_TAG}"
echo "$IMAGE_URI"
```

## 5. Create or update the Cloud Run Job

```bash
cd /root/scan/cloudflare-scan-mvp

GCP_PROJECT_ID="$GCP_PROJECT_ID" \
GCP_LOCATION="$GCP_LOCATION" \
CLOUD_RUN_JOB_NAME="$CLOUD_RUN_JOB_NAME" \
IMAGE_URI="$IMAGE_URI" \
AGENT_SCAN_MODE="mock" \
npm run cloud-run:deploy-job
```

Sanity check:

```bash
gcloud run jobs describe "$CLOUD_RUN_JOB_NAME" \
  --project "$GCP_PROJECT_ID" \
  --region "$GCP_LOCATION"
```

## 6. Create Worker runner service account and key

```bash
cd /root/scan/cloudflare-scan-mvp

export WORKER_KEY_FILE="/tmp/scan-mvp-worker-runner-key.json"

GCP_PROJECT_ID="$GCP_PROJECT_ID" \
GCP_LOCATION="$GCP_LOCATION" \
CLOUD_RUN_JOB_NAME="$CLOUD_RUN_JOB_NAME" \
KEY_FILE="$WORKER_KEY_FILE" \
npm run cloud-run:create-worker-sa
```

Extract credentials into Wrangler secrets. Do not commit the key file.

```bash
node -e 'const k=require(process.argv[1]); console.log(k.client_email)' "$WORKER_KEY_FILE" \
  | npx wrangler secret put GCP_CLIENT_EMAIL

node -e 'const k=require(process.argv[1]); console.log(k.private_key)' "$WORKER_KEY_FILE" \
  | npx wrangler secret put GCP_PRIVATE_KEY
```

Optional cleanup after secrets are set:

```bash
rm -f "$WORKER_KEY_FILE"
```

## 7. Configure Worker secrets

```bash
printf '%s' "$DEV_ADMIN_TOKEN_VALUE" | npx wrangler secret put DEV_ADMIN_TOKEN
printf '%s' "$AGENT_TOKEN_SECRET_VALUE" | npx wrangler secret put AGENT_TOKEN_SECRET
```

If you use a temporary GCP access token instead of service account JWT, set this instead:

```bash
gcloud auth print-access-token | npx wrangler secret put GCP_ACCESS_TOKEN
```

## 8. Deploy Worker in Cloud Run provider mode

The current `wrangler.toml` includes local placeholders. For a production-like E2E, either edit vars in `wrangler.toml` or deploy with explicit vars if your Wrangler version supports them.

Recommended durable path: update the `[vars]` block before deploy:

```toml
[vars]
ENV = "prod"
DEFAULT_PROJECT_ID = "project-default"
MOCK_AGENT_MODE = "manual"
AGENT_PROVIDER = "gcp_cloud_run"
CALLBACK_BASE_URL = "https://<worker-domain>"
AGENT_SCAN_MODE = "mock"
GCP_PROJECT_ID = "<gcp-project-id>"
GCP_LOCATION = "<gcp-location>"
CLOUD_RUN_JOB_NAME = "scan-agent-job"
CLOUD_RUN_CONTAINER_NAME = ""
CLOUD_RUN_DRY_RUN = "false"
```

Then deploy:

```bash
cd /root/scan/cloudflare-scan-mvp
npx wrangler deploy --config wrangler.toml
```

Check health:

```bash
curl "$WORKER_DOMAIN/health"
```

## 9. Create a Cloud Run-backed scan task

Use only an authorized root domain. `example.com` is safe for mock-mode contract verification because the agent will not perform real probing with `AGENT_SCAN_MODE=mock`.

```bash
CREATE_RESPONSE=$(curl -sS -X POST "$WORKER_DOMAIN/api/tasks" \
  -H "Authorization: Bearer $DEV_ADMIN_TOKEN_VALUE" \
  -H "Content-Type: application/json" \
  -d '{"name":"cloud-run mock example.com","targets":["example.com"],"modules":["subdomain","http_probe","nuclei"],"max_agents":1,"rate_limit":50,"timeout_minutes":30}')

echo "$CREATE_RESPONSE"
export TASK_ID=$(node -e 'const p=JSON.parse(process.argv[1]); console.log(p.data.task_id)' "$CREATE_RESPONSE")
echo "$TASK_ID"
```

## 10. Watch Cloud Run execution and Worker state

Check agent run metadata:

```bash
curl -sS -H "Authorization: Bearer $DEV_ADMIN_TOKEN_VALUE" \
  "$WORKER_DOMAIN/api/tasks/$TASK_ID/agent-runs" | jq .
```

The `provider` should be `gcp_cloud_run`, and `provider_job_id` should be a Google operation name, not `dry-run:...`.

List executions:

```bash
gcloud run jobs executions list \
  --job "$CLOUD_RUN_JOB_NAME" \
  --project "$GCP_PROJECT_ID" \
  --region "$GCP_LOCATION"
```

Fetch recent logs:

```bash
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=${CLOUD_RUN_JOB_NAME}" \
  --project "$GCP_PROJECT_ID" \
  --limit 50 \
  --format "value(textPayload)"
```

Poll task completion:

```bash
for i in $(seq 1 60); do
  DETAIL=$(curl -sS -H "Authorization: Bearer $DEV_ADMIN_TOKEN_VALUE" "$WORKER_DOMAIN/api/tasks/$TASK_ID")
  echo "$DETAIL" | jq '{status:.data.status, assets:.data.asset_count, findings:.data.finding_count, artifacts:.data.artifact_count}'
  STATUS=$(echo "$DETAIL" | jq -r '.data.status')
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    break
  fi
  sleep 5
done
```

Expected final state:

```json
{
  "status": "completed",
  "assets": 1,
  "findings": 1,
  "artifacts": 1
}
```

Check results:

```bash
curl -sS -H "Authorization: Bearer $DEV_ADMIN_TOKEN_VALUE" \
  "$WORKER_DOMAIN/api/assets?task_id=$TASK_ID" | jq .

curl -sS -H "Authorization: Bearer $DEV_ADMIN_TOKEN_VALUE" \
  "$WORKER_DOMAIN/api/findings?task_id=$TASK_ID" | jq .

curl -sS -H "Authorization: Bearer $DEV_ADMIN_TOKEN_VALUE" \
  "$WORKER_DOMAIN/api/artifacts?task_id=$TASK_ID" | jq .
```

Download the first artifact:

```bash
ARTIFACT_ID=$(curl -sS -H "Authorization: Bearer $DEV_ADMIN_TOKEN_VALUE" \
  "$WORKER_DOMAIN/api/artifacts?task_id=$TASK_ID" \
  | jq -r '.data.items[0].id')

curl -sS -H "Authorization: Bearer $DEV_ADMIN_TOKEN_VALUE" \
  "$WORKER_DOMAIN/api/artifacts/$ARTIFACT_ID/download"
```

## 11. Troubleshooting

### Task stuck in provisioning

Check agent run:

```bash
curl -sS -H "Authorization: Bearer $DEV_ADMIN_TOKEN_VALUE" \
  "$WORKER_DOMAIN/api/tasks/$TASK_ID/agent-runs" | jq .
```

If `provider_job_id` is empty or task failed, check Worker logs:

```bash
npx wrangler tail --config wrangler.toml
```

If Cloud Run execution exists but task remains provisioning, check Cloud Run logs for callback errors:

```bash
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=${CLOUD_RUN_JOB_NAME}" \
  --project "$GCP_PROJECT_ID" \
  --limit 100
```

Common causes:

- `CALLBACK_BASE_URL` is not the public Worker URL.
- Worker secrets are missing or mismatched.
- Cloud Run job has no outbound internet.
- Cloud Run runner service account lacks `roles/run.invoker` on the job.
- D1 remote `database_id` still points to the local placeholder.

### Token/auth failures

- Rotate `AGENT_TOKEN_SECRET` and redeploy Worker.
- Create a fresh task; old callback tokens are bound to the old secret.
- Ensure Cloud Run env includes `CALLBACK_TOKEN` from the Worker run request.

## 12. Safety notes

- Keep `AGENT_SCAN_MODE=mock` for this E2E contract verification.
- Do not use `http_probe` except for explicitly authorized targets.
- Do not enable port scanning, directory brute force, custom plugins, or user-provided nuclei templates in this phase.
