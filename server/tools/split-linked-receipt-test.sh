#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
export DISPATCH_SOURCE_SKIP_BUILD=1
export DISPATCH_SOURCE_MIGRATIONS="$repo_dir/server/migrations"
exec bash "$repo_dir/docker/run-dispatch-source-tests.sh" node tools/split-linked-receipt-checks.mjs
