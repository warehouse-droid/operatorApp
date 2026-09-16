#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
runner=(bash tools/operator-receiving-identity-test.sh)
artifact=test-artifacts/consolidation-group-planning
mkdir -p "$artifact"
# Preserve RED; reuse the recorded baseline only when explicitly requested.
rm -rf "$artifact/coverage" "$artifact/c8" "$artifact/mutations"
rm -f "$artifact/summary.json" "$artifact/full-final.log" "$artifact/live.json"
if [[ "${CONSOLIDATION_GROUP_REDO_BASELINE:-1}" == 1 ]]; then
  "${runner[@]}" node tools/consolidation-group-planning-checks.mjs --baseline-full
fi
"${runner[@]}" node tools/consolidation-group-planning-checks.mjs
"${runner[@]}" node tools/consolidation-group-planning-mutations.mjs
"${runner[@]}" node tools/consolidation-group-planning-checks.mjs --full
docker run --rm --network none --ipc=host -v "$PWD/public:/app/public:ro" -v "$PWD/test:/app/test:ro" \
  -v "$PWD/test-artifacts:/app/test-artifacts" --entrypoint node mbbs-mbt-p1-test-e2e:latest \
  --test test/dispatch/frontend/consolidation-load.browser.test.mjs > "$artifact/browser-final.log" 2>&1
python3 tools/consolidation-group-planning-live.py
python3 tools/consolidation-group-planning-evidence.py
