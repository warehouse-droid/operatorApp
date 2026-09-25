#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact="$repo_root/server/test-artifacts/actual-arrival-repair"
runner="$repo_root/server/tools/actual-arrival-repair-test.sh"
bash "$runner" node node_modules/c8/bin/c8.js --all=false --check-coverage=false \
  '--include=src/dispatch-actual-arrival-*.js' --include=src/dispatch-forecast-service.js \
  --include=src/driver-repository.js --include=tools/actual-arrival-backfill.mjs \
  --temp-directory=/tmp/actual-arrival-c8 --report-dir=test-artifacts/actual-arrival-repair/coverage \
  --reporter=text --reporter=json --reporter=json-summary \
  node tools/actual-arrival-repair-checks.mjs focused final > "$artifact/coverage-command.log" 2>&1
bash "$runner" node tools/actual-arrival-repair-checks.mjs random final > "$artifact/random-command.log" 2>&1
bash "$runner" node tools/actual-arrival-repair-checks.mjs static current > "$artifact/static-command-current.log" 2>&1
ARRIVAL_REPAIR_SOURCE_ROOT="$artifact/baseline" bash "$runner" node /workspace/server/tools/actual-arrival-repair-checks.mjs static baseline > "$artifact/static-command-baseline.log" 2>&1
bash "$runner" node tools/actual-arrival-repair-mutations.mjs > "$artifact/mutations-command.log" 2>&1
# Both versions currently have six unrelated dispatch-suite failures; compare
# their exact failing files below rather than suppressing the result.
bash "$runner" node tools/dispatch-save-suites.mjs --cancel-first > "$artifact/adjacent-current.log" 2>&1 || true
ARRIVAL_REPAIR_SOURCE_ROOT="$artifact/baseline" bash "$runner" node tools/dispatch-save-suites.mjs --cancel-first > "$artifact/adjacent-baseline.log" 2>&1 || true
python3 server/tools/actual-arrival-repair-evidence.py
