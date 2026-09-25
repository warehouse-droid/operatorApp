#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_root"
runner=server/tools/dispatch-save-reliability-test.sh
mode="${1:-pr}"
case "$mode" in pr|full|replay|release) ;; *) echo "Use pr, full, replay, or release" >&2; exit 2 ;; esac
artifact=server/test-artifacts/dispatch-save-reliability
mkdir -p "$artifact"
baseline="${DISPATCH_SAVE_BASELINE_SOURCE:-$task_root/$artifact/baseline}"
test -d "$baseline/src" || { echo 'Supply DISPATCH_SAVE_BASELINE_SOURCE with the preserved baseline src/public.' >&2; exit 1; }
if [[ ! -d "$artifact/baseline/src" ]]; then
  mkdir -p "$artifact/baseline"
  cp -a "$baseline/src" "$baseline/public" "$artifact/baseline/"
  for file in package.json package-lock.json; do
    if [[ -f "$baseline/$file" ]]; then cp "$baseline/$file" "$artifact/baseline/$file"; fi
  done
fi
run_check() {
  local name="$1"
  shift
  bash "$runner" node tools/dispatch-save-bound-run.mjs "$name" "$@" > "$artifact/$name.log" 2>&1
}
run_check checks node tools/dispatch-save-checks.mjs
# Both suites must finish. Compare named failure counts, never just exit codes.
DISPATCH_SAVE_RELIABILITY_BASELINE="$baseline" run_check adjacent-baseline node tools/dispatch-save-suites.mjs baseline --cancel-first || adjacent_baseline_exit=$?
run_check adjacent node node_modules/c8/bin/c8.js --all=false --check-coverage=false --include='src/*' --include='public/dispatch*.js' \
  --reporter=json --report-dir=test-artifacts/dispatch-save-reliability/coverage-adjacent \
  --temp-directory=test-artifacts/dispatch-save-reliability/v8-adjacent \
  node tools/dispatch-save-suites.mjs random --cancel-first || adjacent_exit=$?
python3 server/tools/dispatch-save-compare.py suite "$artifact/adjacent-baseline.log" "$artifact/adjacent.log" --output "$artifact/adjacent-comparison.json"
DISPATCH_SAVE_RELIABILITY_BASELINE="$baseline" run_check static-baseline node tools/dispatch-save-static.mjs baseline
run_check static node tools/dispatch-save-static.mjs candidate
python3 server/tools/dispatch-save-compare.py static "$artifact/static-baseline.json" "$artifact/static-candidate.json" --output "$artifact/static-comparison.json"
DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="${DISPATCH_SAVE_BROWSER_IMAGE:-mbbs-mbt-p1-test-e2e:latest}" run_check playwright node tools/dispatch-save-playwright.mjs
DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="${DISPATCH_SAVE_BROWSER_IMAGE:-mbbs-mbt-p1-test-e2e:latest}" run_check journal node tools/dispatch-save-journal-browser.mjs
DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="${DISPATCH_SAVE_BROWSER_IMAGE:-mbbs-mbt-p1-test-e2e:latest}" run_check snapshot-browser node tools/dispatch-save-snapshot-browser.mjs
DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="${DISPATCH_SAVE_BROWSER_IMAGE:-mbbs-mbt-p1-test-e2e:latest}" run_check source-browser node tools/dispatch-save-source-browser.mjs
run_check coverage node tools/dispatch-save-coverage.mjs
run_check secrets node tools/dispatch-save-secrets.mjs
run_check complexity node tools/dispatch-save-complexity.mjs
run_check rollback node tools/dispatch-save-rollback.mjs
DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="${DISPATCH_SAVE_BROWSER_IMAGE:-mbbs-mbt-p1-test-e2e:latest}" run_check inventory node tools/dispatch-save-inventory.mjs
if [[ "$mode" == full || "$mode" == release ]]; then
  DISPATCH_SAVE_RELIABILITY_BASELINE="$baseline" run_check full-baseline npm test || full_baseline_exit=$?
  run_check full npm test || full_exit=$?
  python3 server/tools/dispatch-save-compare.py suite "$artifact/full-baseline.log" "$artifact/full.log" --output "$artifact/full-comparison.json"
  run_check stress node tools/dispatch-save-stress.mjs stress
  run_check races node tools/dispatch-save-stress.mjs races
  for round in 1 2 3; do
    variants=(baseline candidate)
    if [[ "$round" == 2 ]]; then variants=(candidate baseline); fi
    for variant in "${variants[@]}"; do
      if [[ "$variant" == baseline ]]; then
        DISPATCH_SAVE_RELIABILITY_BASELINE="$baseline" DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="${DISPATCH_SAVE_BROWSER_IMAGE:-mbbs-mbt-p1-test-e2e:latest}" run_check browser-baseline node tools/dispatch-save-browser.mjs baseline
      else
        DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="${DISPATCH_SAVE_BROWSER_IMAGE:-mbbs-mbt-p1-test-e2e:latest}" run_check browser-candidate node tools/dispatch-save-browser.mjs candidate
      fi
      cp "$artifact/browser-$variant.json" "$artifact/browser-$variant-series-$round.json"
      cp "$artifact/browser-$variant.log" "$artifact/browser-$variant-series-$round.log"
    done
  done
  for round in {1..13}; do
    variants=(candidate baseline)
    if (( round % 2 == 0 )); then variants=(baseline candidate); fi
    for variant in "${variants[@]}"; do
      if [[ "$variant" == baseline ]]; then
        DISPATCH_SAVE_RELIABILITY_BASELINE="$baseline" DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="${DISPATCH_SAVE_BROWSER_IMAGE:-mbbs-mbt-p1-test-e2e:latest}" run_check cold-baseline node tools/dispatch-save-browser.mjs baseline --startup-trace
      else
        DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="${DISPATCH_SAVE_BROWSER_IMAGE:-mbbs-mbt-p1-test-e2e:latest}" run_check cold-candidate node tools/dispatch-save-browser.mjs candidate --startup-trace
      fi
      cp "$artifact/browser-$variant-trace.json" "$artifact/browser-$variant-cold-series-$round.json"
      cp "$artifact/cold-$variant.log" "$artifact/browser-$variant-cold-series-$round.log"
    done
  done
  python3 server/tools/dispatch-save-performance.py --series series- --replicates 3 --cold-series cold-series- --cold-replicates 13
  run_check soak node tools/dispatch-save-stress.mjs soak
fi
if [[ "$mode" == replay || "$mode" == release ]]; then
  # Private corpus is supplied locally; these commands never capture production.
  bash server/tools/dispatch-save-history-replay.sh replay-final-report.json > "$artifact/history-final.log" 2>&1
  bash server/tools/dispatch-save-history-replay.sh replay-source-events.json --source-events > "$artifact/history-source-events.log" 2>&1
fi
if [[ "$mode" == release ]]; then
  DISPATCH_SAVE_RELIABILITY_BASELINE="$baseline" run_check flake-order-baseline node tools/dispatch-save-flake-check.mjs order-baseline --cancel-first
  run_check flake-order-candidate node tools/dispatch-save-flake-check.mjs order-candidate --cancel-first
fi
if [[ "$mode" == pr || "$mode" == full || "$mode" == release ]]; then
  python3 server/tools/dispatch-save-evidence.py --scope "$mode" --check
fi
