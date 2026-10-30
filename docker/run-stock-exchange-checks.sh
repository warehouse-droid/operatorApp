#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
export DISPATCH_SOURCE_SKIP_BUILD=1
export DISPATCH_SOURCE_MIGRATIONS="$repo_dir/server/migrations"
bash "$repo_dir/docker/run-dispatch-source-tests.sh" node tools/stock-exchange-checks.mjs "$@"
