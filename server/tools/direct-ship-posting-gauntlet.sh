#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact="$server_root/test-artifacts/direct-ship-posting-20261001"
runner="$server_root/tools/direct-ship-posting-test.sh"
baseline="$artifact/baseline"
candidate="$artifact/regression-source"
# Existing baseline failures are measured, never hidden. Comparison rejects any
# new failed assertion, failed file, cancellation, or timeout.
full() {
  local source_path="$1" output_path="$2"; shift 2
  env DIRECT_SHIP_POSTING_SOURCE="$source_path" DIRECT_SHIP_POSTING_TOOL="$server_root/tools/direct-ship-posting-full.mjs" \
    bash "$runner" node /app/direct-ship-runner.mjs "$@" > "$output_path" 2>&1 || [[ $? == 1 ]]
}
full "$baseline" "$artifact/baseline-bounded-full.log" & baseline_pid=$!
full "$candidate" "$artifact/candidate-full-1-419.log" 1 419 & head_pid=$!
full "$candidate" "$artifact/candidate-full-420-599.log" 420 599 & middle_pid=$!
full "$candidate" "$artifact/candidate-full-600-771.log" 600 771 & tail_pid=$!
wait "$baseline_pid" "$head_pid" "$middle_pid" "$tail_pid"
python3 tools/direct-ship-posting-regression-compare.py
bash "$runner" node --test --test-concurrency=1 \
  test/mbt/unit/direct-ship-posting.test.js test/mbt/integration/direct-ship-posting.test.js \
  test/mbt/unit/sales-order-auto-fulfillment.red.test.js test/mbt/unit/sales-order-auto-fulfillment-service.red.test.js \
  test/mbt/unit/operator-netsuite-posting-domain.red.test.js test/mbt/unit/operator-netsuite-posting-runtime-adapters.red.test.js \
  test/mbt/concurrency/operator-netsuite-posting-concurrency.test.js test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js \
  test/mbt/property/operator-netsuite-posting.property.test.js > "$artifact/exact-candidate.log" 2>&1
bash "$runner" node_modules/.bin/c8 --all=false --include='src/direct-po-auto-receipt*.js' --include=src/netsuite-fulfillable-items.js \
  --reporter=json-summary --reporter=json --reporter=text --report-dir=test-artifacts/direct-ship-posting-20261001/coverage \
  --temp-directory=/tmp/direct-ship-c8 node --test --test-concurrency=1 test/mbt/unit/direct-ship-posting.test.js \
  test/mbt/integration/direct-ship-posting.test.js test/mbt/concurrency/operator-netsuite-posting-concurrency.test.js > "$artifact/coverage.log" 2>&1
bash "$runner" node tools/direct-ship-posting-mutations.mjs > "$artifact/mutations.log" 2>&1
env DIRECT_SHIP_POSTING_SOURCE="$baseline" bash "$runner" node_modules/.bin/tsc -p tsconfig.mbt.json > "$artifact/baseline-types.log" 2>&1 || [[ $? == 1 || $? == 2 ]]
bash "$runner" node_modules/.bin/tsc -p tsconfig.mbt.json > "$artifact/candidate-types.log" 2>&1 || [[ $? == 1 || $? == 2 ]]
bash "$runner" node_modules/.bin/eslint --config tools/direct-ship-posting-eslint.config.mjs --max-warnings=0 \
  src/direct-po-auto-receipt.js src/direct-po-auto-receipt-domain.js src/netsuite-fulfillable-items.js \
  src/operator-netsuite-posting-domain.js src/operator-netsuite-posting-finalizer.js src/operator-netsuite-posting-netsuite-adapter.js \
  src/operator-netsuite-posting-targets.js src/sales-order-auto-fulfillment-netsuite-adapter.js \
  src/sales-order-auto-fulfillment-repository.js src/sales-order-auto-fulfillment-runtime.js src/sales-order-auto-fulfillment-service.js \
  test/mbt/unit/direct-ship-posting.test.js test/mbt/integration/direct-ship-posting.test.js > "$artifact/lint-final.log" 2>&1
env DIRECT_SHIP_POSTING_SOURCE="$baseline" DIRECT_SHIP_POSTING_TOOL="$server_root/tools/direct-ship-posting-migration.mjs" \
  bash "$runner" node /app/direct-ship-runner.mjs > "$artifact/migration-rollback.log" 2>&1
docker run --rm --network none --memory=512m --cpus=1 -e DIRECT_SHIP_CHECK_SERVER=/workspace/server \
  -v "$server_root/..:/workspace:ro" -v "$server_root/tools:/app/tools:ro" -v "$server_root/test:/app/test:ro" \
  -v "$server_root/test-artifacts:/app/test-artifacts" --entrypoint node mbbs-regular-v2:e2e tools/direct-ship-posting-checks.mjs
