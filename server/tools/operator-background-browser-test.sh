#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="${BACKGROUND_PHOTO_SOURCE:-$task_root/server}"
docker run --rm --network none --shm-size=512m --user "$(id -u):$(id -g)" \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -v "$source_root/public:/app/public:ro" -v "$task_root/server/test:/app/test:ro" \
  -v "$task_root/server/test-artifacts/schedule-columns/browser-cache:/ms-playwright:ro" \
  --entrypoint node mbbs-scm-search-vendor-test:20260910 --test test/mbt/e2e/operator-photo-outbox.test.js
