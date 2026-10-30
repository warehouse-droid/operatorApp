#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
set +e
bash "$repo_dir/docker/run-isolated-tests.sh" node tools/return-enhancements-checks.mjs "$@" >"$MBBS_TEST_ARTIFACT_DIR/complete-run.log" 2>&1
result=$?
set -e
tail -160 "$MBBS_TEST_ARTIFACT_DIR/complete-run.log"
exit "$result"
