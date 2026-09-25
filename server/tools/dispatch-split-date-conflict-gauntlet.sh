#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact=server/test-artifacts/split-date-conflict
mkdir -p "$artifact/baseline"
cp server/src/server.js "$artifact/baseline/server.js"
patch --silent "$artifact/baseline/server.js" < server/test/support/dispatch-split-date-conflict-baseline.patch
runner=(bash server/tools/dispatch-split-date-conflict-test.sh)
sha256sum server/src/server.js server/test/dispatch/unit/dispatch-split-date-conflict.test.js \
  server/test/dispatch/integration/dispatch-split-date-conflict.test.js > "$artifact/final-source.sha256"
"${runner[@]}" node tools/dispatch-split-date-conflict-checks.mjs > "$artifact/checks-run.log" 2>&1
"${runner[@]}" node --test --test-concurrency=1 test/dispatch/integration/dispatch-split-date-conflict.test.js \
  test/dispatch/concurrency/dispatch-v2-stale-command.red.test.js \
  test/dispatch/concurrency/dispatch-plan-authoritative-projection-concurrency.red.test.js \
  test/dispatch/integration/dispatch-save-recovery.red.test.js > "$artifact/adjacent.log" 2>&1
SPLIT_DATE_BASELINE=1 "${runner[@]}" npm run typecheck:mbt > "$artifact/types-baseline.log" 2>&1 || true
"${runner[@]}" npm run typecheck:mbt > "$artifact/types-final.log" 2>&1 || true
python3 server/tools/dispatch-retired-confirm-evidence.py types "$artifact/types-baseline.log" "$artifact/types-final.log"
SPLIT_DATE_BASELINE=1 "${runner[@]}" node node_modules/eslint/bin/eslint.js --config test/support/retired-confirm-eslint.config.mjs \
  --max-warnings=0 src/server.js > "$artifact/lint-baseline.log" 2>&1 || true
"${runner[@]}" node node_modules/eslint/bin/eslint.js --config test/support/retired-confirm-eslint.config.mjs --max-warnings=0 \
  src/server.js test/dispatch/unit/dispatch-split-date-conflict.test.js test/dispatch/integration/dispatch-split-date-conflict.test.js \
  test/support/dispatch-split-date-conflict-harness.mjs tools/replay-dispatch-split-date-conflict.mjs \
  tools/dispatch-split-date-conflict-checks.mjs > "$artifact/lint-final.log" 2>&1 || true
python3 server/tools/dispatch-retired-confirm-evidence.py lint "$artifact/lint-baseline.log" "$artifact/lint-final.log"
"${runner[@]}" node test/support/scan-diff-secrets.mjs src/server.js test/dispatch-split-date-conflict-spec.md \
  test/dispatch/unit/dispatch-split-date-conflict.test.js test/dispatch/integration/dispatch-split-date-conflict.test.js \
  test/support/dispatch-split-date-conflict-harness.mjs tools/dispatch-split-date-conflict-checks.mjs \
  tools/replay-dispatch-split-date-conflict.mjs tools/dispatch-split-date-conflict-deploy.py \
  tools/dispatch-split-date-conflict-test.sh tools/dispatch-split-date-conflict-gauntlet.sh \
  test/dispatch-split-date-conflict-evidence.md test/support/dispatch-split-date-conflict-baseline.patch > "$artifact/secrets.log" 2>&1
if [[ "${SPLIT_DATE_REUSE_FULL:-0}" != 1 ]]; then
  SPLIT_DATE_BASELINE=1 "${runner[@]}" npm test > "$artifact/full-baseline.log" 2>&1 || baseline_exit=$?
  "${runner[@]}" npm test > "$artifact/full-final.log" 2>&1 || final_exit=$?
fi
python3 server/tools/dispatch-retired-confirm-evidence.py compare "$artifact/full-baseline.log" "$artifact/full-final.log"
python3 server/tools/dispatch-split-date-conflict-deploy.py check
sha256sum --check "$artifact/final-source.sha256"
git diff --check
