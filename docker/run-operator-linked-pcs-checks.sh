#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export DISPATCH_SOURCE_SKIP_BUILD=1
exec bash "$repo_dir/docker/run-dispatch-source-tests.sh" node tools/operator-linked-pcs-checks.mjs "$@"
