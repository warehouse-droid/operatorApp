#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
git show edc61458f0e0cb74f47d06221cd6f45e2e1a2c82:server/src/operator-order-progress-repository.js > "$MBBS_TEST_ARTIFACT_DIR/operator-progress-cargo-baseline.js"
bash docker/run-isolated-tests.sh node tools/operator-progress-cargo-checks.mjs
cp "$MBBS_TEST_ARTIFACT_DIR/operator-progress-cargo-evidence.json" server/test/dispatch/specs/operator-progress-cargo-20261022-evidence.json
