#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
runner=(bash tools/operator-receiving-identity-test.sh)
artifact=test-artifacts/operator-posting-latency
# Preserve RED/baseline evidence; remove outputs that must come from this run.
rm -rf "$artifact/coverage" "$artifact/c8" "$artifact/smoke-coverage" "$artifact/smoke-c8" "$artifact/mutations"
rm -f "$artifact/full-final.log" "$artifact/summary.json" "$artifact/browser.json" "$artifact/smoke.json" "$artifact/live.json"
# Existing baseline evidence may be reused only for this captured pre-task source.
if [[ "${POSTING_REDO_BASELINE:-1}" == 1 ]]; then
  "${runner[@]}" node tools/operator-posting-latency-checks.mjs --baseline-full
fi
"${runner[@]}" node tools/operator-posting-latency-checks.mjs
"${runner[@]}" node tools/operator-posting-latency-mutations.mjs
"${runner[@]}" node_modules/.bin/c8 --all=false --check-coverage=false --exclude='**/node_modules/**' \
  --include=src/server.js --reporter=json --temp-directory="$artifact/smoke-c8" --report-dir="$artifact/smoke-coverage" \
  node tools/operator-posting-latency-smoke.mjs
"${runner[@]}" node tools/operator-posting-latency-checks.mjs --full
docker run --rm --network none --ipc=host -v "$PWD/public:/app/public:ro" -v "$PWD/tools:/app/tools:ro" \
  -v "$PWD/test-artifacts:/app/test-artifacts" --entrypoint node mbbs-mbt-p1-test-e2e:latest tools/operator-posting-latency-browser.mjs
docker run --rm --network none --ipc=host -v "$PWD/public:/app/public:ro" -v "$PWD/test:/app/test:ro" \
  -v "$PWD/test-artifacts:/app/test-artifacts" --entrypoint node mbbs-mbt-p1-test-e2e:latest \
  --test test/dispatch/frontend/consolidation-load.browser.test.mjs > "$artifact/consolidation-browser-final.log" 2>&1
python3 tools/operator-posting-latency-live.py
python3 tools/operator-posting-latency-evidence.py
