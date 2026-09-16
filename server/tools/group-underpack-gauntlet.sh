#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
export FULFILLED_SO_SOURCE_ROOT="$repo/docker/backups/group-underpack-20260915/release"
artifact="$repo/server/test-artifacts/group-underpack-20260915"
run_layer() {
  local name="$1"
  shift
  export FULFILLED_SO_RUN_TAG="group-underpack-${name}-$(date +%s)"
  bash server/tools/dispatch-fulfilled-so-test.sh "$@" > "$artifact/$name.log" 2>&1
}
python3 server/tools/group-underpack-oracle.py
FULFILLED_SO_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest run_layer browser node tools/group-underpack-browser.mjs
run_layer gauntlet node tools/group-underpack-gauntlet.mjs
run_layer full-mbt npm run test:mbt || true
run_layer cache-contracts node --test --test-concurrency=1 --test-reporter=spec test/mbt/unit/operations-navigation-enhancements.test.js test/mbt/unit/operator-customer-pickup-photo-gate-ui.contract.test.js test/mbt/unit/operator-page-confirm-ui.contract.test.js
run_layer types npm run typecheck:mbt || true
python3 server/tools/group-underpack-evidence.py
