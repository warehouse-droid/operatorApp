#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact=server/test-artifacts/split-address
python3 server/tools/dispatch-split-address-prepare.py
SPLIT_ADDRESS_BASELINE=1 bash server/tools/dispatch-split-address-test.sh node tools/dispatch-split-address-files.mjs \
  test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js \
  test/dispatch/integration/dispatch-v2-command-flow.red.test.js \
  test/dispatch/integration/dispatch-v2-snapshot-performance.red.test.js \
  test/dispatch/integration/scm-pob03658-split-driver-lifecycle.red.test.js \
  test/dispatch/unit/dispatch-repeat-pickup-visits.red.test.js > "$artifact/baseline-failures.log" 2>&1 || baseline_status=$?
test "${baseline_status:-0}" -eq 1
bash server/tools/dispatch-split-address-test.sh node tools/dispatch-split-address-suite.mjs \
  > "$artifact/regression-final.log" 2>&1 || regression_status=$?
test "${regression_status:-0}" -eq 1
python3 server/tools/dispatch-split-address-evidence.py
bash server/tools/dispatch-split-address-test.sh node tools/dispatch-split-address-checks.mjs
SPLIT_TARGET_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest bash server/tools/dispatch-split-target-test.sh node --test \
  test/dispatch/frontend/dispatch-split-address.browser.test.mjs \
  test/dispatch/frontend/dispatch-split-target.browser.test.mjs > "$artifact/browser-final.log" 2>&1
