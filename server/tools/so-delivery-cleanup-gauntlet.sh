#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
artifact="$repo/server/test-artifacts/so-delivery-cleanup-apply-20260915"
mkdir -p "$artifact"
export FULFILLED_SO_SOURCE_ROOT="${CLEANUP_SOURCE_ROOT:-$repo/docker/backups/so-delivery-cleanup-20260915/release}"
run() { bash server/tools/dispatch-fulfilled-so-test.sh "$@"; }
FULFILLED_SO_COVERAGE_DIR=/app/test-artifacts/so-delivery-cleanup-apply-20260915/focused-coverage run node --test --test-concurrency=1 \
  test/dispatch/unit/so-delivery-cleanup.test.js test/dispatch/integration/so-delivery-cleanup.test.js \
  test/dispatch/unit/local-co-loaded.test.js test/dispatch/unit/co-source-cleanup.test.js test/dispatch/integration/co-source-cleanup.test.js \
  test/dispatch/unit/dispatch-fulfilled-so-policy.test.js test/dispatch/frontend/dispatch-fulfilled-so-ui.test.js \
  test/dispatch/integration/dispatch-fulfilled-so-planning.test.js test/dispatch/integration/dispatch-fulfilled-so-http.test.js \
  test/dispatch/concurrency/dispatch-fulfilled-so-planning.test.js \
  test/dispatch/integration/dispatch-reconciliation-completed-planning.red.test.js \
  test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js \
  test/dispatch/integration/dispatch-retired-confirm.test.js test/dispatch/integration/sov-dispatch.test.js \
  > "$artifact/focused-final.log" 2>&1
run node tools/so-delivery-cleanup-mutations.mjs > "$artifact/mutations-final.log" 2>&1
run node tools/co-source-cleanup-mutations.mjs > "$artifact/co-mutations-final.log" 2>&1
run node node_modules/eslint/bin/eslint.js --config tools/so-delivery-cleanup-eslint.config.mjs \
  tools/so-delivery-cleanup-domain.mjs tools/so-delivery-cleanup-repository.mjs tools/so-delivery-cleanup-cli.mjs \
  tools/so-delivery-cleanup-today-read.mjs tools/so-delivery-cleanup-result-read.mjs tools/so-delivery-cleanup-mutations.mjs \
  tools/co-source-cleanup-repository.mjs tools/co-source-cleanup-cli.mjs tools/co-source-cleanup-mutations.mjs \
  src/local-co-loaded-policy.js > "$artifact/lint-final.log" 2>&1
run node node_modules/c8/bin/c8.js report --all=false --check-coverage=false \
  --temp-directory=test-artifacts/so-delivery-cleanup-apply-20260915/focused-coverage \
  --reports-dir=test-artifacts/so-delivery-cleanup-apply-20260915/c8 \
  '--include=tools/so-delivery-cleanup-domain.mjs' '--include=tools/so-delivery-cleanup-repository.mjs' '--include=tools/co-source-cleanup-repository.mjs' '--include=src/local-co-loaded-policy.js' \
  --reporter=json --reporter=json-summary --reporter=text > "$artifact/coverage-final.log" 2>&1
run node -p 'JSON.stringify({node:process.version,fastCheck:require("fast-check/package.json").version,eslint:require("eslint/package.json").version,c8:require("c8/package.json").version})' > "$artifact/versions-final.json"
printf 'Cleanup and planning gauntlet passed.\n'
