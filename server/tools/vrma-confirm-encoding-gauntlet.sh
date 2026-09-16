#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
export FULFILLED_SO_SOURCE_ROOT="$repo/docker/backups/vrma-confirm-encoding-20260915/release-final"
artifact="$repo/server/test-artifacts/vrma-confirm-encoding-20260915"
run_layer() {
  local name="$1"
  shift
  export FULFILLED_SO_RUN_TAG="vrma-encoding-${name}-$(date +%s)"
  bash server/tools/dispatch-fulfilled-so-test.sh "$@" > "$artifact/$name.log" 2>&1
}
run_layer gauntlet node tools/vrma-confirm-encoding-gauntlet.mjs
run_layer full-mbt-final npm run test:mbt || true
run_layer types-final npm run typecheck:mbt || true
python3 server/tools/vrma-confirm-encoding-evidence.py
