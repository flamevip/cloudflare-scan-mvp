#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${AGENT_DIR:-${ROOT_DIR}/agent/real}"
PROJECT_ID="${GCP_PROJECT_ID:-${PROJECT_ID:-}}"
LOCATION="${GCP_LOCATION:-${LOCATION:-}}"
REPOSITORY="${ARTIFACT_REPOSITORY:-scan-mvp}"
IMAGE_NAME="${IMAGE_NAME:-scan-agent}"
IMAGE_TAG="${IMAGE_TAG:-v0.1.0}"
DRY_RUN="${DRY_RUN:-false}"
GENERATE_SBOM="${GENERATE_SBOM:-false}"
SBOM_OUT="${SBOM_OUT:-${ROOT_DIR}/agent/real/sbom.spdx.json}"
SBOM_TOOL="${SBOM_TOOL:-syft}"
SIGN_IMAGE="${SIGN_IMAGE:-false}"
VERIFY_SIGNATURE="${VERIFY_SIGNATURE:-false}"

usage() {
  cat <<'EOF'
Build and push the scan-agent image to Google Artifact Registry.

Required environment:
  GCP_PROJECT_ID or PROJECT_ID
  GCP_LOCATION or LOCATION

Optional environment:
  ARTIFACT_REPOSITORY=scan-mvp
  IMAGE_NAME=scan-agent
  IMAGE_TAG=v0.1.0
  AGENT_DIR=/path/to/agent/real
  DRY_RUN=true
  GENERATE_SBOM=true         # emits syft/docker SBOM command; requires tool only when not dry-run
  SBOM_OUT=agent/real/sbom.spdx.json
  SBOM_TOOL=syft
  SIGN_IMAGE=true            # signs immutable digest URI with cosign; requires digest form
  VERIFY_SIGNATURE=true      # verifies immutable digest URI with cosign

Example:
  GCP_PROJECT_ID=my-project GCP_LOCATION=asia-east1 ./scripts/cloud-run-build-agent.sh
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

REGISTRY_HOST="${LOCATION}-docker.pkg.dev"
IMAGE_URI="${REGISTRY_HOST}/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${IMAGE_TAG}"
DIGEST_URI="${DIGEST_URI:-}"

run gcloud services enable artifactregistry.googleapis.com run.googleapis.com --project "$PROJECT_ID"
run gcloud artifacts repositories create "$REPOSITORY" \
  --project "$PROJECT_ID" \
  --repository-format docker \
  --location "$LOCATION" \
  --description "Scan MVP agent images" || true
run gcloud auth configure-docker "$REGISTRY_HOST" --quiet
run docker build -t "$IMAGE_URI" "$AGENT_DIR"
run docker push "$IMAGE_URI"

if [[ -z "$DIGEST_URI" ]]; then
  if [[ "$DRY_RUN" == "true" ]]; then
    DIGEST_URI="${REGISTRY_HOST}/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}@sha256:<digest-after-push>"
  else
    DIGEST_URI="$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_URI" 2>/dev/null || true)"
  fi
fi

if [[ -n "$DIGEST_URI" ]]; then
  echo "IMAGE_URI=$IMAGE_URI"
  echo "DIGEST_URI=$DIGEST_URI"
else
  echo "IMAGE_URI=$IMAGE_URI"
  echo "DIGEST_URI unavailable; inspect Artifact Registry before deploy" >&2
fi

if [[ "$GENERATE_SBOM" == "true" ]]; then
  run "$SBOM_TOOL" "$IMAGE_URI" -o "spdx-json=$SBOM_OUT"
fi

if [[ "$SIGN_IMAGE" == "true" ]]; then
  require_digest_uri "$DIGEST_URI" "SIGN_IMAGE"
  run cosign sign "$DIGEST_URI"
fi

if [[ "$VERIFY_SIGNATURE" == "true" ]]; then
  require_digest_uri "$DIGEST_URI" "VERIFY_SIGNATURE"
  run cosign verify "$DIGEST_URI"
fi
