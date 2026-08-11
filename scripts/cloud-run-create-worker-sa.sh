#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-${PROJECT_ID:-}}"
LOCATION="${GCP_LOCATION:-${LOCATION:-}}"
JOB_NAME="${CLOUD_RUN_JOB_NAME:-${JOB_NAME:-scan-agent-job}}"
WORKER_SA_NAME="${WORKER_SA_NAME:-scan-mvp-worker-runner}"
KEY_FILE="${KEY_FILE:-}"
DRY_RUN="${DRY_RUN:-false}"

usage() {
  cat <<'EOF'
Create a minimal service account for the Worker to run a Cloud Run Job.

Required environment:
  GCP_PROJECT_ID or PROJECT_ID
  GCP_LOCATION or LOCATION

Optional environment:
  CLOUD_RUN_JOB_NAME=scan-agent-job
  WORKER_SA_NAME=scan-mvp-worker-runner
  KEY_FILE=/secure/path/worker-runner-key.json  # if set, create a key file for Wrangler secrets
  DRY_RUN=true

After creating a key file, set Worker secrets from it; do not commit the key file.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

require() {
  local value="$1"
  local name="$2"
  if [[ -z "$value" ]]; then
    echo "Missing required env: $name" >&2
    usage >&2
    exit 1
  fi
}

run() {
  printf '+ %q ' "$@"
  printf '\n'
  if [[ "$DRY_RUN" != "true" ]]; then
    "$@"
  fi
}

require "$PROJECT_ID" "GCP_PROJECT_ID"
require "$LOCATION" "GCP_LOCATION"

WORKER_SA_EMAIL="${WORKER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
JOB_RESOURCE="projects/${PROJECT_ID}/locations/${LOCATION}/jobs/${JOB_NAME}"

if ! gcloud iam service-accounts describe "$WORKER_SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud iam service-accounts create "$WORKER_SA_NAME" \
    --project "$PROJECT_ID" \
    --display-name "Scan MVP Worker Cloud Run runner"
fi

# run.invoker includes run.jobs.run for Cloud Run Jobs. Bind at the job level when the job exists.
if gcloud run jobs describe "$JOB_NAME" --project "$PROJECT_ID" --region "$LOCATION" >/dev/null 2>&1; then
  run gcloud run jobs add-iam-policy-binding "$JOB_NAME" \
    --project "$PROJECT_ID" \
    --region "$LOCATION" \
    --member "serviceAccount:${WORKER_SA_EMAIL}" \
    --role "roles/run.invoker"
else
  echo "Cloud Run Job ${JOB_RESOURCE} does not exist yet; skipping job-level IAM binding." >&2
fi

if [[ -n "$KEY_FILE" ]]; then
  run gcloud iam service-accounts keys create "$KEY_FILE" \
    --project "$PROJECT_ID" \
    --iam-account "$WORKER_SA_EMAIL"
fi

echo "$WORKER_SA_EMAIL"
