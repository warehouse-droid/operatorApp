#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
export FULFILLED_SO_SOURCE_ROOT="$repo/docker/backups/to-conflict-cleanup-20260915/runtime"
artifact="$repo/server/test-artifacts/to-conflict-cleanup-20260915"
run_layer() {
  local name="$1"
  shift
  export FULFILLED_SO_RUN_TAG="to-conflict-${name}-$(date +%s)"
  bash server/tools/dispatch-fulfilled-so-test.sh "$@" > "$artifact/$name.log" 2>&1
}
# The captured NetSuite proof must still be fresh for the guarded rehearsal.
# This entry point never applies changes to production.
run_layer final node tools/to-conflict-gauntlet.mjs
run_layer dispatch-final-2 node tools/to-cleanup-suite.mjs regression || true
run_layer mbt-final npm run test:mbt || true
run_layer types-final npm run typecheck:mbt || true
run_layer secrets-toolchain sh -c 'node test/support/scan-diff-secrets.mjs tools/to-conflict-* test/dispatch/unit/to-conflict-cleanup.test.js test/dispatch/integration/to-conflict-cleanup.test.js && node --version && npm --version'
# Baseline failures are accepted only after the exact comparison below.
python3 server/tools/to-conflict-evidence.py
