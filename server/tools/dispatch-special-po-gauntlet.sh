#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
baseline="$server_root/test-artifacts/dispatch-special-po-deployment-20260925/baseline"
test -d "$baseline"
run_check() {
  local check="$1"
  shift
  if sudo -n env SPECIAL_PO_CHECK="$check" bash tools/dispatch-special-po-test.sh "$@" \
    > "test-artifacts/dispatch-special-po-$check.log" 2>&1; then
    printf '%s passed\n' "$check"
  else
    printf '%s has failures; comparing with production baseline\n' "$check"
  fi
}
run_check full-mbt npm test
run_check related node tools/dispatch-special-po-suites.mjs
run_check random node tools/dispatch-special-po-suites.mjs random
run_check final-layers bash tools/dispatch-special-po-layers.sh
sudo -n env SPECIAL_PO_CHECK=baseline-static SPECIAL_PO_SOURCE_ROOT="$baseline" \
  bash tools/dispatch-special-po-test.sh node tools/dispatch-special-po-static.mjs \
  > test-artifacts/dispatch-special-po-baseline-static.log 2>&1
if sudo -n env SPECIAL_PO_CHECK=baseline-related SPECIAL_PO_SOURCE_ROOT="$baseline" \
  bash tools/dispatch-special-po-test.sh node tools/dispatch-special-po-suites.mjs \
  src/dispatch-driver-order-harness.js test/dispatch/frontend/dispatch-completion-ui.test.js \
  > test-artifacts/dispatch-special-po-baseline-related.log 2>&1; then :; fi
python3 tools/dispatch-special-po-evidence.py replay
python3 tools/dispatch-special-po-evidence.py check
