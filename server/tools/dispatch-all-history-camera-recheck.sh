#!/usr/bin/env bash
set -Eeuo pipefail
history_server="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$history_server/.."
history_artifact="$history_server/test-artifacts/dispatch-all-history-20261002"
export DISPATCH_ALL_HISTORY_SOURCE_ROOT="$history_artifact/final-source"
export DISPATCH_ALL_HISTORY_BASELINE_ROOT="$history_artifact/workspace-baseline"
export DISPATCH_ALL_HISTORY_IMAGE=mbbs-regular-v2:e2e
for history_repeat in 1 2; do
  for history_kind in baseline candidate; do
    bash "$history_server/tools/dispatch-all-history-environment.sh" "$history_kind-exec" \
      node tools/dispatch-all-history-bounded-command.mjs node tools/dispatch-all-history-selected-tests.mjs \
      test/dispatch/frontend/operator-camera-rollback.browser.test.mjs \
      > "$history_artifact/camera-$history_kind-$history_repeat.log" 2>&1 || true
  done
done
