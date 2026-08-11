#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-${PROJECT_ID:-}}"
LOCATION="${GCP_LOCATION:-${LOCATION:-}}"
JOB_NAME="${CLOUD_RUN_JOB_NAME:-${JOB_NAME:-scan-agent-job}}"
IMAGE_URI="${IMAGE_URI:-}"
SERVICE_ACCOUNT="${CLOUD_RUN_SERVICE_ACCOUNT:-}"
SCAN_MODE="${AGENT_SCAN_MODE:-mock}"
CPU="${CLOUD_RUN_CPU:-1}"
MEMORY="${CLOUD_RUN_MEMORY:-512Mi}"
TASK_TIMEOUT="${CLOUD_RUN_TASK_TIMEOUT:-1800s}"
MAX_RETRIES="${CLOUD_RUN_MAX_RETRIES:-0}"
DRY_RUN="${DRY_RUN:-false}"
REQUIRE_IMAGE_DIGEST="${REQUIRE_IMAGE_DIGEST:-false}"
VERIFY_SIGNATURE="${VERIFY_SIGNATURE:-false}"

usage() {
  cat <<'EOF'
Create or update the Cloud Run Job used by the Worker Cloud Run provider.

Required environment:
  GCP_PROJECT_ID or PROJECT_ID
  GCP_LOCATION or LOCATION
  IMAGE_URI               # prefer immutable image@sha256:<digest>

Optional environment:
  CLOUD_RUN_JOB_NAME=scan-agent-job
  CLOUD_RUN_SERVICE_ACCOUNT=scan-agent-runtime@project.iam.gserviceaccount.com
  AGENT_SCAN_MODE=mock|http_probe|real_toolchain
  CLOUD_RUN_CPU=1
  CLOUD_RUN_MEMORY=512Mi
  CLOUD_RUN_TASK_TIMEOUT=1800s
  CLOUD_RUN_MAX_RETRIES=0
  REQUIRE_IMAGE_DIGEST=true
  VERIFY_SIGNATURE=true
  DRY_RUN=true

Example:
  GCP_PROJECT_ID=my-project GCP_LOCATION=asia-east1 IMAGE_URI=asia-east1-docker.pkg.dev/my-project/scan-mvp/scan-agent@sha256:... ./scripts/cloud-run-deploy-job.sh
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

require_digest_uri() {
  local image="$1"
  local action="$2"
  if [[ "$image" != *@sha256:* ]]; then
    echo "$action requires immutable image digest URI, got: $image" >&2
    exit 1
  fi
}

require "$PROJECT_ID" "GCP_PROJECT_ID"
require "$LOCATION" "GCP_LOCATION"
require "$IMAGE_URI" "IMAGE_URI"

if [[ "$IMAGE_URI" != *@sha256:* ]]; then
  if [[ "$REQUIRE_IMAGE_DIGEST" == "true" ]]; then
    require_digest_uri "$IMAGE_URI" "REQUIRE_IMAGE_DIGEST"
  else
    echo "Warning: IMAGE_URI is tag-based; prefer image@sha256:<digest> for reproducible deploys" >&2
  fi
fi

if [[ "$VERIFY_SIGNATURE" == "true" ]]; then
  require_digest_uri "$IMAGE_URI" "VERIFY_SIGNATURE"
  run cosign verify "$IMAGE_URI"
fi

COMMON_FLAGS=(
  --project "$PROJECT_ID"
  --region "$LOCATION"
  --image "$IMAGE_URI"
  --tasks 1
  --max-retries "$MAX_RETRIES"
  --task-timeout "$TASK_TIMEOUT"
  --cpu "$CPU"
  --memory "$MEMORY"
  --set-env-vars "SCAN_MODE=${SCAN_MODE}"
)

if [[ -n "$SERVICE_ACCOUNT" ]]; then
  COMMON_FLAGS+=(--service-account "$SERVICE_ACCOUNT")
fi

if gcloud run jobs describe "$JOB_NAME" --project "$PROJECT_ID" --region "$LOCATION" >/dev/null 2>&1; then
  run gcloud run jobs update "$JOB_NAME" "${COMMON_FLAGS[@]}"
else
  run gcloud run jobs create "$JOB_NAME" "${COMMON_FLAGS[@]}"
fi

run gcloud run jobs describe "$JOB_NAME" --project "$PROJECT_ID" --region "$LOCATION" --format "value(name)"
