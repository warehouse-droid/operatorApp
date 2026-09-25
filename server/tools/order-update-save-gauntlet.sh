#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_root"
runner=server/tools/dispatch-save-reliability-test.sh
artifact=server/test-artifacts/order-update-save
baseline="$task_root/$artifact/baseline"
browser_image="${DISPATCH_SAVE_BROWSER_IMAGE:-mbbs-mbt-p1-test-e2e:latest}"
mkdir -p "$artifact"
python3 server/tools/order-update-save-baseline.py > "$artifact/baseline-reconstruction.log"
python3 server/tools/order-update-save-state.py begin > "$artifact/final-source-hash.txt"
docker image inspect --format '{{.RepoTags}} {{.Id}}' mbbs-retired-confirm-test:20260914 "$browser_image" postgres:18-alpine > "$artifact/images.txt"
run() {
  local name="$1"
  shift
  bash "$runner" "$@" > "$artifact/$name.log" 2>&1
}
covered() {
  local name="$1"
  shift
  run "$name" node node_modules/c8/bin/c8.js --all=false --check-coverage=false \
    --include='src/dispatch-*.js' --include='src/delivery-repository.js' --include='src/server.js' --include='public/dispatch.js' \
    --reporter=json --report-dir="test-artifacts/order-update-save/coverage-$name" \
    --temp-directory="test-artifacts/order-update-save/v8-$name" "$@"
}
run checks node tools/order-update-save-checks.mjs & checks_pid=$!
DISPATCH_SAVE_RELIABILITY_BASELINE="$baseline" run full-baseline npm test & baseline_pid=$!
covered full npm test & candidate_pid=$!
wait "$checks_pid"
wait "$baseline_pid" || baseline_exit=$?
wait "$candidate_pid" || candidate_exit=$?
python3 server/tools/dispatch-save-compare.py suite "$artifact/full-baseline.log" "$artifact/full.log" --output "$artifact/full-comparison.json"
DISPATCH_SAVE_RELIABILITY_BASELINE="$baseline" run adjacent-baseline node tools/order-update-save-suites.mjs adjacent & baseline_pid=$!
covered adjacent node tools/order-update-save-suites.mjs adjacent & candidate_pid=$!
DISPATCH_SAVE_RELIABILITY_BASELINE="$baseline" run static-baseline node tools/order-update-save-static.mjs baseline
run static-candidate node tools/order-update-save-static.mjs candidate
wait "$baseline_pid" || baseline_exit=$?
wait "$candidate_pid" || candidate_exit=$?
python3 server/tools/dispatch-save-compare.py suite "$artifact/adjacent-baseline.log" "$artifact/adjacent.log" --output "$artifact/adjacent-comparison.json"
python3 server/tools/dispatch-save-compare.py static "$artifact/static-baseline.json" "$artifact/static-candidate.json" --output "$artifact/static-comparison.json"
run complexity node tools/order-update-save-complexity.mjs
run secrets node tools/order-update-save-secrets.mjs
covered startup node tools/order-update-save-startup.mjs
covered rollback node tools/order-update-save-rollback.mjs
if [[ -f "$artifact/private-incident.json" ]]; then
  covered incident node tools/order-update-save-incident-replay.mjs
else
  printf '%s\n' 'Private incident replay omitted: capture not supplied. The minimized HTTP regression always runs.' > "$artifact/incident.log"
fi
DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="$browser_image" run browser node tools/order-update-save-browser.mjs
run coverage node tools/order-update-save-coverage.mjs
for round in 1 2 3; do
  variants=(baseline candidate)
  if [[ "$round" == 2 ]]; then variants=(candidate baseline); fi
  for variant in "${variants[@]}"; do
    if [[ "$variant" == baseline ]]; then
      DISPATCH_SAVE_RELIABILITY_BASELINE="$baseline" DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="$browser_image" \
        run "benchmark-$variant-$round" node tools/order-update-save-benchmark.mjs baseline
    else
      DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="$browser_image" run "benchmark-$variant-$round" node tools/order-update-save-benchmark.mjs candidate
    fi
    cp "$artifact/browser-$variant.json" "$artifact/browser-$variant-pair-$round.json"
  done
done
python3 server/tools/dispatch-save-performance.py --directory "$artifact" --series pair- --replicates 3 > "$artifact/performance.log"
python3 server/tools/order-update-save-state.py end
