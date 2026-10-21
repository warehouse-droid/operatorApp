#!/usr/bin/env bash
set -Eeuo pipefail
release_server="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$release_server/.."
release_artifact="$release_server/test-artifacts/dispatch-all-history-20261002/cargo-route"
release_environment="$release_server/tools/dispatch-all-history-environment.sh"
export DISPATCH_ALL_HISTORY_SOURCE_ROOT="$release_artifact/release-final-source"
export DISPATCH_ALL_HISTORY_IMAGE=mbbs-regular-v2:test
test -f "$release_server/deployments/dispatch-history-cargo-20261002/deployment-result.json"
test ! -e "$release_artifact/release-save-replays/pass-1.json"
for release_pass in 1 2; do
  if [[ "$release_pass" = 2 || "${1:-}" != --already-reset ]]; then
    bash "$release_environment" reset > "$release_artifact/release-reset-$release_pass.log" 2>&1
  fi
  printf 'Starting deployed-source history and cargo pass %s at %s\n' "$release_pass" "$(date -u +%FT%TZ)"
  bash "$release_environment" history-exec env \
    DISPATCH_CARGO_REPORT_DIRECTORY=test-artifacts/dispatch-all-history-20261002/cargo-route/release-content-replays \
    node tools/dispatch-history-cargo-replay.mjs "$release_pass" > "$release_artifact/release-cargo-pass-$release_pass.log" 2>&1 &
  release_audit_pid=$!
  if ! bash "$release_environment" history-exec env \
    DISPATCH_HISTORY_REPORT_DIRECTORY=test-artifacts/dispatch-all-history-20261002/cargo-route/release-save-replays \
    node tools/dispatch-all-history-replay.mjs "$release_pass" > "$release_artifact/release-save-pass-$release_pass.log" 2>&1; then
    wait "$release_audit_pid" || true
    printf 'History pass %s stopped; inspect its saved failure before resuming.\n' "$release_pass"
    exit 1
  fi
  wait "$release_audit_pid"
  printf 'Completed deployed-source history and cargo pass %s at %s\n' "$release_pass" "$(date -u +%FT%TZ)"
done
