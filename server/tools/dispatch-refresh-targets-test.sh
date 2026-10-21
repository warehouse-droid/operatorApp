#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export DISPATCH_FRESHNESS_ARTIFACT="$repo_root/server/test-artifacts/dispatch-refresh-targets-20261019"
export DISPATCH_FRESHNESS_PROJECT=mbbs-dispatch-refresh-targets-test
export DISPATCH_FRESHNESS_ROOT="${DISPATCH_REFRESH_SOURCE:-$DISPATCH_FRESHNESS_ARTIFACT/before}"
exec bash "$repo_root/server/tools/dispatch-freshness-test.sh" "$@"
