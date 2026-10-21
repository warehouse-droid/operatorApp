#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact="$repo_root/server/test-artifacts/executed-order-review"
baseline="${EXECUTION_REVIEW_BASELINE:-$artifact/baseline}"
runner="$repo_root/server/tools/executed-order-review-test.sh"
test -f "$baseline/src/dispatch-plan-repository.js" || {
  echo "Provide the pre-change source capture using EXECUTION_REVIEW_BASELINE for regression comparison." >&2
  exit 1
}
mkdir -p "$artifact"
bash "$runner" node tools/executed-order-review-suites.mjs > "$artifact/focused-final.log" 2>&1
bash "$runner" node tools/executed-order-review-suites.mjs random > "$artifact/random-final.log" 2>&1
current_status=0
baseline_status=0
bash "$runner" node tools/dispatch-save-suites.mjs --cancel-first > "$artifact/adjacent-current-final.log" 2>&1 || current_status=$?
EXECUTION_REVIEW_SOURCE_ROOT="$baseline" bash "$runner" node tools/dispatch-save-suites.mjs --cancel-first > "$artifact/adjacent-baseline-final.log" 2>&1 || baseline_status=$?
echo "Adjacent suite exit codes: current=$current_status baseline=$baseline_status"
bash "$runner" node tools/executed-order-review-mutations.mjs > "$artifact/mutations-final.log" 2>&1
bash "$runner" node node_modules/c8/bin/c8.js --all=false --check-coverage=false \
  '--include=src/dispatch-executed-order-review*.js' \
  --include=src/dispatch-address-guard.js --include=public/dispatch-address-guard.js \
  --temp-directory=/tmp/executed-review-c8 --report-dir=test-artifacts/executed-order-review/coverage \
  --reporter=text --reporter=json --reporter=json-summary \
  node --test --test-concurrency=1 \
  test/dispatch/unit/dispatch-executed-order-review.test.js \
  test/dispatch/unit/dispatch-executed-order-incidents.test.js \
  test/dispatch/property/dispatch-executed-order-review.test.js \
  test/dispatch/integration/dispatch-executed-order-review.test.js \
  test/mbt/unit/driver-live-route-prefix-lock.red.test.js \
  test/mbt/adversarial/driver-live-route-prefix-lock.adversarial.test.js > "$artifact/coverage-final.log" 2>&1
bash "$runner" node /workspace/server/tools/executed-order-review-static.mjs current > "$artifact/static-final.log" 2>&1
EXECUTION_REVIEW_SOURCE_ROOT="$baseline" bash "$runner" node /workspace/server/tools/executed-order-review-static.mjs baseline >> "$artifact/static-final.log" 2>&1
bash "$runner" node tools/executed-order-review-replay.mjs test/dispatch/fixtures/executed-order-incidents.json > "$artifact/replay-final.json" 2>&1
docker image inspect field-sales-check-2941306:latest --format '{{.Id}}' > "$artifact/image-final.txt"
docker run --rm --network none --entrypoint node field-sales-check-2941306:latest -p \
  'JSON.stringify({node:process.version,fastCheck:require("fast-check/package.json").version,eslint:require("eslint/package.json").version,typescript:require("typescript/package.json").version,c8:require("c8/package.json").version,playwright:require("@playwright/test/package.json").version})' > "$artifact/versions-final.json"
python3 server/tools/executed-order-review-evidence.py "$baseline"
