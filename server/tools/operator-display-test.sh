#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="${DISPLAY_FIX_SOURCE_ROOT:-$repo_root/server}"
kind="${1:?unit, browser, or db}"; shift
if [[ "$kind" == db ]]; then
  CHILD_LOCATION_SOURCE_ROOT="$source_root" bash "$repo_root/server/tools/child-location-test.sh" "$@"
  exit
fi
mounts=()
for directory in src public test tools migrations contracts; do
  mounts+=(-v "$source_root/$directory:/app/$directory:ro")
done
for file in "$source_root"/*.json "$source_root"/*.js; do
  mounts+=(-v "$file:/app/$(basename "$file"):ro")
done
image=mbbs-retired-confirm-test:20260914
if [[ "$kind" == browser ]]; then image=mbbs-return-batch-browser-test:20260918; fi
docker run --rm --network none --shm-size=512m \
  -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_REPO_ROOT=/workspace \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e DISPLAY_FIX_COVERAGE="${DISPLAY_FIX_COVERAGE:-0}" \
  -e DISPLAY_FIX_ARTIFACTS="${DISPLAY_FIX_ARTIFACTS:-test-artifacts/operator-display-fix/browser}" \
  "${mounts[@]}" -v "$repo_root:/workspace:ro" \
  -v "$repo_root/server/test-artifacts:/app/test-artifacts" \
  -v "$repo_root/server/test-artifacts/schedule-columns/browser-cache:/ms-playwright:ro" \
  --entrypoint "$1" "$image" "${@:2}"
