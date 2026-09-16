#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact="$repo_root/server/test-artifacts/dispatch-so-fulfilled-planning"
python3 server/tools/dispatch-fulfilled-so-baseline.py
python3 server/tools/dispatch-fulfilled-so-evidence.py prepare
run() { bash server/tools/dispatch-fulfilled-so-test.sh "$@"; }
if [[ "${FULFILLED_SO_REUSE_BASELINE:-0}" != "1" ]]; then
  FULFILLED_SO_SOURCE_ROOT="$artifact/baseline" run node tools/operator-yard-full-suite.mjs > "$artifact/baseline-full-final.log" 2>&1 || true
  FULFILLED_SO_SOURCE_ROOT="$artifact/baseline" run node tools/dispatch-fulfilled-so-suite.mjs > "$artifact/baseline-dispatch-full-final.log" 2>&1 || true
fi
run node tools/operator-yard-full-suite.mjs > "$artifact/full-final.log" 2>&1 & full_pid=$!
run node tools/dispatch-fulfilled-so-suite.mjs > "$artifact/dispatch-full-final.log" 2>&1 & dispatch_pid=$!
python3 - <<'PY'
from pathlib import Path
import shutil
p=Path('server/test-artifacts/dispatch-so-fulfilled-planning/coverage-tmp')
if p.exists(): shutil.rmtree(p)
p.mkdir(parents=True)
PY
FULFILLED_SO_COVERAGE_DIR=/app/test-artifacts/dispatch-so-fulfilled-planning/coverage-tmp run node --test --test-concurrency=1 \
  test/dispatch/unit/dispatch-fulfilled-so-policy.test.js test/dispatch/frontend/dispatch-fulfilled-so-ui.test.js \
  test/dispatch/integration/dispatch-fulfilled-so-planning.test.js test/dispatch/integration/dispatch-fulfilled-so-http.test.js \
  test/dispatch/concurrency/dispatch-fulfilled-so-planning.test.js \
  test/dispatch/integration/dispatch-reconciliation-completed-planning.red.test.js \
  test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js \
  test/dispatch/integration/dispatch-retired-confirm.test.js test/dispatch/integration/sov-dispatch.test.js \
  > "$artifact/focused-final.log" 2>&1
FULFILLED_SO_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest run node --test test/dispatch/frontend/dispatch-fulfilled-so.browser.test.mjs > "$artifact/browser-final.log" 2>&1
run node tools/dispatch-fulfilled-so-mutations.mjs > "$artifact/mutations-final.log" 2>&1
run node tools/dispatch-fulfilled-so-static.mjs current > "$artifact/static-final.log" 2>&1
FULFILLED_SO_SOURCE_ROOT="$artifact/baseline" run node tools/dispatch-fulfilled-so-static.mjs baseline >> "$artifact/static-final.log" 2>&1
run node test/support/scan-diff-secrets.mjs --unified-diff test-artifacts/dispatch-so-fulfilled-planning/task.patch \
  tools/dispatch-fulfilled-so-test.sh tools/dispatch-fulfilled-so-gauntlet.sh tools/dispatch-fulfilled-so-evidence.py \
  tools/dispatch-fulfilled-so-mutations.mjs > "$artifact/secrets-final.log" 2>&1
run node -p 'JSON.stringify({node:process.version,fastCheck:require("fast-check/package.json").version,eslint:require("eslint/package.json").version,typescript:require("typescript/package.json").version,c8:require("c8/package.json").version})' > "$artifact/versions-final.json"
wait "$full_pid" || true
wait "$dispatch_pid" || true
run node tools/dispatch-fulfilled-so-coverage.mjs > "$artifact/coverage-final.log" 2>&1
run node node_modules/c8/bin/c8.js report --all=false --check-coverage=false \
  --temp-directory=test-artifacts/dispatch-so-fulfilled-planning/coverage-tmp \
  --reports-dir=test-artifacts/dispatch-so-fulfilled-planning/c8 \
  '--include=src/dispatch-fulfilled-so-*.js' --reporter=json-summary --reporter=text \
  > "$artifact/branch-coverage-final.log" 2>&1
python3 server/tools/dispatch-fulfilled-so-evidence.py > "$artifact/summary.log"
