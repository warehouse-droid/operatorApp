#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image_id="$(docker inspect mbbs-operator-app-app-1 --format '{{.Image}}')"
# Reuse only existing configuration; mount source and application data read-only.
docker run --rm --network mbbs-operator-app_mbbs --user 0:0 \
  -v "$repo_root/docker/env/.env:/app/.env:ro" \
  -v "$repo_root/docker/env/.env.old:/app/.env.old:ro" \
  -v mbbs-operator-app_app_data:/app/data:ro \
  -v "$repo_root/server/src/operator-netsuite-posting-domain.js:/app/src/operator-netsuite-posting-domain.js:ro" \
  -v "$repo_root/server/src/operator-netsuite-posting-targets.js:/app/src/operator-netsuite-posting-targets.js:ro" \
  -v "$repo_root/server/tools/sn1400333-receiving-live.mjs:/app/tools/sn1400333-receiving-live.mjs:ro" \
  --entrypoint node "$image_id" tools/sn1400333-receiving-live.mjs
