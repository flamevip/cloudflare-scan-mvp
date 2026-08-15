#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${1:?Wrangler config path is required}"
DEPLOYMENT_MESSAGE="${2:-GitHub Worker deployment}"
DEPLOY_LOG="$(mktemp)"
trap 'rm -f "$DEPLOY_LOG"' EXIT

set +e
npx wrangler deploy --config "$CONFIG_PATH" 2>&1 | tee "$DEPLOY_LOG"
DEPLOY_STATUS="${PIPESTATUS[0]}"
set -e

if [ "$DEPLOY_STATUS" -eq 0 ]; then
  exit 0
fi

# An existing custom-domain route does not need to be recreated for a code-only
# deployment. Keep the normal deploy path for trigger/config convergence, but
# allow a least-privilege token to update the Worker version when the only
# failure is the Zone Workers Routes permission check.
if ! grep -Fq '/workers/routes' "$DEPLOY_LOG" || ! grep -Eq 'Authentication error.*code: 10000' "$DEPLOY_LOG"; then
  exit "$DEPLOY_STATUS"
fi

echo 'Zone Workers Routes permission is unavailable; preserving existing routes and deploying a Worker Version.'
UPLOAD_OUTPUT="$(NO_COLOR=1 npx wrangler versions upload --config "$CONFIG_PATH" --message "$DEPLOYMENT_MESSAGE" 2>&1)"
printf '%s\n' "$UPLOAD_OUTPUT"
VERSION_ID="$(printf '%s\n' "$UPLOAD_OUTPUT" | grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' | tail -n 1)"
if [ -z "$VERSION_ID" ]; then
  echo 'Unable to determine the uploaded Worker Version ID.' >&2
  exit 1
fi

npx wrangler versions deploy "${VERSION_ID}@100%" --config "$CONFIG_PATH" --yes --message "$DEPLOYMENT_MESSAGE"
