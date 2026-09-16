#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
test "$#" -gt 0
docker run --rm --network mbbs-operator-app_mbbs --user "$(id -u):$(id -g)" \
  -e MBBS_ENV_FILE=/app/.env -e NODE_ENV=production \
  -v "$repo/docker/env/.env:/app/.env:ro" \
  -v "$repo/server/tools:/app/tools:ro" \
  -v "$repo/server/test-artifacts:/app/test-artifacts" \
  --entrypoint node mbbs-operator-app:so-delivery-cleanup-20260915-v1 "$@"
