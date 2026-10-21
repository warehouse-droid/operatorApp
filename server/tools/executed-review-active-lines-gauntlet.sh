#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact="$server_root/test-artifacts/executed-review-active-lines"
mkdir -p "$artifact"
if [[ ! -f "$artifact/baseline/dispatch-repository.js" ]]; then
  baseline_work="$(mktemp -d /tmp/executed-review-baseline.XXXXXX)"
  mkdir -p "$baseline_work/src" "$baseline_work/public" "$artifact/baseline"
  files=(src/dispatch-repository.js src/dispatch-executed-order-review-repository.js src/dispatch-executed-order-review.js public/dispatch.js)
  for file in "${files[@]}"; do cp "$file" "$baseline_work/$file"; done
  git -C "$baseline_work" apply --reverse "$server_root/test/dispatch-executed-review-active-lines.changes.patch"
  for file in "${files[@]}"; do cp "$baseline_work/$file" "$artifact/baseline/$(basename "$file")"; done
  rm -rf "$baseline_work"
fi
run_id="executed-active-lines-$(date +%Y%m%d%H%M%S)-$$"
checks="$server_root/test-artifacts/mbt-bin-planning/checks/$run_id/executed-review-active-lines"
coverage="$server_root/test-artifacts/mbt-bin-planning/checks/$run_id-coverage/executed-review-active-lines"
BIN_PLANNING_CHECK="$run_id" bash tools/bin-planning-test.sh node tools/executed-review-active-lines-check.mjs all > "$artifact/verified.log" 2>&1
BIN_PLANNING_CHECK="$run_id-coverage" bash tools/bin-planning-test.sh node node_modules/c8/bin/c8.js \
  --all=false --check-coverage=false --include=src/dispatch-repository.js \
  --include=src/dispatch-executed-order-review-repository.js --include=src/dispatch-executed-order-review.js \
  --include=public/dispatch.js --temp-directory=/tmp/executed-active-lines-c8 \
  --report-dir=test-artifacts/executed-review-active-lines/coverage --reporter=json --reporter=json-summary \
  node tools/executed-review-active-lines-check.mjs coverage > "$artifact/verified-coverage.log" 2>&1
docker run --rm --network none --entrypoint node mbbs-bin-planning-test:20260927 -p \
  'JSON.stringify({node:process.version,fastCheck:require("fast-check/package.json").version,eslint:require("eslint/package.json").version,typescript:require("typescript/package.json").version,c8:require("c8/package.json").version,playwright:require("@playwright/test/package.json").version})' > "$artifact/versions.json"
docker image inspect mbbs-bin-planning-test:20260927 --format '{{.Id}}' > "$artifact/test-image.txt"
if [[ "${1:-}" == "--live" ]]; then python3 tools/executed-review-active-lines-live.py > "$artifact/live-replay-output.json"; fi
python3 tools/executed-review-active-lines-evidence.py "$checks" "$coverage" "$artifact/verified.log"
