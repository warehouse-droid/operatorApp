#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact="$server_root/test-artifacts/dispatch-weight-save"
mkdir -p "$artifact"
if [[ ! -f "$artifact/baseline/dispatch-plan-repository.js" ]]; then
  baseline_work="$(mktemp -d /tmp/dispatch-weight-save-baseline.XXXXXX)"
  mkdir -p "$baseline_work/src" "$artifact/baseline"
  for file in dispatch-plan-repository.js dispatch-load-assignment.js dispatch-executed-order-review.js dispatch-planner-performance.js; do
    cp "src/$file" "$baseline_work/src/$file"
  done
  git -C "$baseline_work" apply --reverse "$server_root/test/dispatch-weight-save.changes.patch"
  cp "$baseline_work"/src/*.js "$artifact/baseline/"
  rm -rf "$baseline_work"
fi
run_id="weight-save-$(date +%Y%m%d%H%M%S)-$$"
printf '%s\n' "$run_id" > "$artifact/final-run-id"
export BIN_PLANNING_CHECK="$run_id"
bash tools/bin-planning-test.sh bash -c '
  set -Eeuo pipefail
  node tools/dispatch-weight-save-check.mjs suites
  node node_modules/c8/bin/c8.js --all=false --check-coverage=false \
    --include=src/dispatch-plan-repository.js --include=src/dispatch-load-assignment.js \
    --include=src/dispatch-executed-order-review.js --include=src/dispatch-planner-performance.js \
    --temp-directory=/tmp/dispatch-weight-save-c8 --report-dir=test-artifacts/dispatch-weight-save/coverage \
    --reporter=json --reporter=json-summary node tools/dispatch-weight-save-check.mjs focused
  node tools/dispatch-weight-save-check.mjs mutations
  node tools/dispatch-weight-save-check.mjs static
' > "$artifact/gauntlet.log" 2>&1
python3 tools/dispatch-weight-save-evidence.py "$server_root/test-artifacts/mbt-bin-planning/checks/$run_id/dispatch-weight-save"
printf 'Checks: %s\n' "$server_root/test-artifacts/mbt-bin-planning/checks/$run_id/dispatch-weight-save"
