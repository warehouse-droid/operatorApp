#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact="$server_root/test-artifacts/dispatch-weight-notices"
mkdir -p "$artifact/baseline"
if [[ ! -f "$artifact/baseline/dispatch-executed-order-review.js" ]]; then
  baseline_work="$(mktemp -d /tmp/dispatch-weight-baseline.XXXXXX)"
  mkdir -p "$baseline_work/src" "$baseline_work/public"
  for file in src/dispatch-repository.js src/dispatch-executed-order-review.js src/dispatch-executed-order-review-repository.js public/dispatch.js; do
    cp "$file" "$baseline_work/$file"
  done
  git -C "$baseline_work" apply --reverse "$server_root/test/dispatch-weight-notices.changes.patch"
  for file in dispatch-executed-order-review.js dispatch-executed-order-review-repository.js; do
    cp "$baseline_work/src/$file" "$artifact/baseline/$file"
  done
  if [[ ! -f "$server_root/test-artifacts/executed-review-active-lines/baseline/dispatch-repository.js" ]]; then
    git -C "$baseline_work" apply --reverse "$server_root/test/dispatch-executed-review-active-lines.changes.patch"
    mkdir -p "$server_root/test-artifacts/executed-review-active-lines/baseline"
    for file in src/dispatch-repository.js src/dispatch-executed-order-review.js src/dispatch-executed-order-review-repository.js public/dispatch.js; do
      cp "$baseline_work/$file" "$server_root/test-artifacts/executed-review-active-lines/baseline/$(basename "$file")"
    done
  fi
  rm -rf "$baseline_work"
fi
run_id="weight-notices-$(date +%Y%m%d%H%M%S)-$$"
BIN_PLANNING_CHECK="$run_id-adjacent" bash tools/bin-planning-test.sh node tools/executed-review-active-lines-check.mjs suites > "$artifact/adjacent.log" 2>&1
BIN_PLANNING_CHECK="$run_id-checks" bash tools/bin-planning-test.sh node node_modules/c8/bin/c8.js \
  --all=false --check-coverage=false --include=src/dispatch-executed-order-review.js \
  --include=src/dispatch-executed-order-review-repository.js --temp-directory=/tmp/dispatch-weight-notices-c8 \
  --report-dir=test-artifacts/dispatch-weight-notices/coverage --reporter=json --reporter=json-summary \
  node tools/dispatch-weight-review-check.mjs all > "$artifact/gauntlet.log" 2>&1
python3 tools/dispatch-weight-review-evidence.py \
  "$server_root/test-artifacts/mbt-bin-planning/checks/$run_id-checks/dispatch-weight-notices" \
  "$server_root/test-artifacts/mbt-bin-planning/checks/$run_id-adjacent/executed-review-active-lines"
