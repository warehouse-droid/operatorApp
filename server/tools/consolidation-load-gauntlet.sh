#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact="$repo_root/server/test-artifacts/consolidation-load"
mkdir -p "$artifact/baseline"
baseline="$(python3 -c 'import json; print(json.load(open("server/test/consolidation-load-manifest.json"))["baselineCommit"])')"
if [[ ! -e "$artifact/baseline/src/server.js" ]]; then
  git archive "$baseline:server" | tar -x -C "$artifact/baseline"
fi
python3 server/tools/consolidation-load-evidence.py prepare
python3 - <<'PY'
from pathlib import Path
import shutil
coverage = Path('server/test-artifacts/consolidation-load/coverage-tmp')
if coverage.exists(): shutil.rmtree(coverage)
coverage.mkdir(parents=True)
PY
run() { bash server/tools/consolidation-load-test.sh "$@"; }
CONSOLIDATION_COVERAGE_DIR=/app/test-artifacts/consolidation-load/coverage-tmp run node tools/operator-yard-full-suite.mjs > "$artifact/full-final.log" 2>&1 & current_pid=$!
CONSOLIDATION_SOURCE_ROOT="$artifact/baseline" run node tools/operator-yard-full-suite.mjs > "$artifact/baseline-full-final.log" 2>&1 & baseline_pid=$!
CONSOLIDATION_COVERAGE_DIR=/app/test-artifacts/consolidation-load/coverage-tmp run node --test --test-concurrency=1 \
  test/mbt/unit/consolidation-load.test.js test/mbt/unit/consolidation-load-posting.test.js test/mbt/integration/consolidation-load.test.js \
  test/mbt/unit/operator-yard-assets.test.js test/mbt/integration/migration-upgrade.test.js \
  > "$artifact/focused-final.log" 2>&1
CONSOLIDATION_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest run node --test --test-concurrency=1 \
  test/dispatch/frontend/consolidation-load.browser.test.mjs test/dispatch/frontend/dispatch-pool-session.browser.test.mjs \
  > "$artifact/browser-final.log" 2>&1
CONSOLIDATION_BROWSER_COVERAGE=1 CONSOLIDATION_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest run node --test \
  test/dispatch/frontend/consolidation-load.browser.test.mjs > "$artifact/browser-coverage-final.log" 2>&1
CONSOLIDATION_COVERAGE_DIR=/app/test-artifacts/consolidation-load/coverage-tmp CONSOLIDATION_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest \
  run node tools/consolidation-load-e2e.mjs > "$artifact/e2e-final.log" 2>&1
run node tools/consolidation-load-mutations.mjs > "$artifact/mutations-final.log" 2>&1
run node tools/consolidation-load-static.mjs current > "$artifact/static-final.log" 2>&1
CONSOLIDATION_SOURCE_ROOT="$artifact/baseline" run node tools/consolidation-load-static.mjs baseline >> "$artifact/static-final.log" 2>&1
run node test/support/scan-diff-secrets.mjs --unified-diff test-artifacts/consolidation-load/task.patch \
  tools/consolidation-load-test.sh tools/consolidation-load-gauntlet.sh tools/consolidation-load-evidence.py tools/consolidation-load-mutations.mjs \
  > "$artifact/secrets-final.log" 2>&1
run node -p 'JSON.stringify({node:process.version,fastCheck:require("fast-check/package.json").version,eslint:require("eslint/package.json").version,typescript:require("typescript/package.json").version,c8:require("c8/package.json").version})' \
  > "$artifact/versions-final.json"
wait "$current_pid" || true
wait "$baseline_pid" || true
run node tools/consolidation-load-coverage.mjs > "$artifact/coverage-final.log" 2>&1
python3 server/tools/consolidation-load-evidence.py
