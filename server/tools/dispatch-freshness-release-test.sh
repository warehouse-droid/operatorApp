#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export DISPATCH_FRESHNESS_ROOT="$repo_root/server/deployments/dispatch-freshness-20261019/candidate"
export DISPATCH_FRESHNESS_ARTIFACT="$repo_root/server/deployments/dispatch-freshness-20261019/validation"
export DISPATCH_FRESHNESS_PROJECT=mbbs-dispatch-freshness-release-test
if [[ "$#" == 0 ]]; then set -- node tools/dispatch-freshness-release-checks.mjs; fi
exec bash "$repo_root/server/tools/dispatch-freshness-test.sh" "$@"
