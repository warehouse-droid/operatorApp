#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="${BACKGROUND_PHOTO_SOURCE:-$task_root/server}"
mounts=(-v "$source_root/src:/app/src:ro" -v "$source_root/public:/app/public:ro")
for directory in tools test contracts; do mounts+=(-v "$task_root/server/$directory:/app/$directory:ro"); done
for file in "$task_root/server"/*.json "$task_root/server"/*.js; do mounts+=(-v "$file:/app/$(basename "$file"):ro"); done
docker run --rm --network none --user "$(id -u):$(id -g)" "${mounts[@]}" \
  -v "$task_root/server/test-artifacts:/app/test-artifacts" --entrypoint node \
  mbbs-retired-confirm-test:20260914 tools/operator-background-checks.mjs "${1:-static}"
