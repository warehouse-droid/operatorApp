#!/usr/bin/env bash
# Reproduce checks of the staged image without touching the production database.
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_root"
release="$task_root/server/test-artifacts/order-update-save/deployment"
runner=server/tools/order-update-save-release-test.sh
run_case() {
  local variant="$1"
  shift
  local source="$release/candidate"
  if [[ "$variant" == baseline ]]; then source="$release/app-before"; fi
  ORDER_UPDATE_RELEASE_SOURCE="$source" ORDER_UPDATE_RELEASE_ARTIFACT="$release/$variant-artifacts" \
    bash "$runner" "$@"
}
run_case candidate node tools/order-update-save-suites.mjs focused > "$release/focused.log" 2>&1 & focused_pid=$!
python3 server/tools/order-update-save-image-smoke.py > "$release/image-smoke.log" 2>&1 & smoke_pid=$!
run_case baseline npm test > "$release/full-baseline.log" 2>&1 & baseline_pid=$!
run_case candidate npm test > "$release/full.log" 2>&1 & candidate_pid=$!
wait "$focused_pid"
wait "$smoke_pid"
wait "$baseline_pid" || baseline_exit=$?
wait "$candidate_pid" || candidate_exit=$?
python3 server/tools/dispatch-save-compare.py suite "$release/full-baseline.log" "$release/full.log" --output "$release/full-comparison.json"
run_case baseline node tools/order-update-save-suites.mjs adjacent > "$release/adjacent-baseline.log" 2>&1 & baseline_pid=$!
run_case candidate node tools/order-update-save-suites.mjs adjacent > "$release/adjacent.log" 2>&1 & candidate_pid=$!
wait "$baseline_pid" || baseline_exit=$?
wait "$candidate_pid" || candidate_exit=$?
python3 server/tools/dispatch-save-compare.py suite "$release/adjacent-baseline.log" "$release/adjacent.log" --output "$release/adjacent-comparison.json"
ORDER_UPDATE_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest \
  run_case candidate node tools/order-update-save-browser.mjs > "$release/browser.log" 2>&1
python3 server/tools/order-update-save-deploy.py check
