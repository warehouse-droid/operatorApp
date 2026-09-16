#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="${SPLIT_TARGET_TEST_IMAGE:-mbbs-retired-confirm-test:20260914}"
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
  -v "$repo_root/server/public:/app/public:ro" \
  -v "$repo_root/server/src:/app/src:ro" \
  -v "$repo_root/server/test:/app/test:ro" \
  -v "$repo_root/server/tools:/app/tools:ro" \
  -v "$repo_root/server/test-artifacts:/app/test-artifacts" \
  --entrypoint "$1" "$image" "${@:2}"
