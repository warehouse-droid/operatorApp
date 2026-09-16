#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
docker run --rm --network mbbs-operator-app_mbbs --user 0:0 \
  -v "$repo_root/docker/env/.env:/app/.env:ro" \
  -v "$repo_root/server/src/operator-yard-authorization.js:/app/candidate/operator-yard-authorization.js:ro" \
  -v "$repo_root/server/src/receiving-repository.js:/app/src/receiving-repository-candidate.js:ro" \
  -v "$repo_root/server/public/operator.js:/app/public/operator-candidate.js:ro" \
  -v "$repo_root/server/tools:/app/tools:ro" \
  -v "$repo_root/server/test-artifacts:/app/test-artifacts" \
  --entrypoint node mbbs-operator-app:operator-display-20260915-v1 \
  tools/operator-receiving-split-search-audit.mjs
