#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
export DISPATCH_SOURCE_SKIP_BUILD=1
export DISPATCH_SOURCE_RUNTIME="${PARTIAL_POSTING_RUNTIME:-$root/server/deployments/partial-linked-posting-20261027/candidate}"
export DISPATCH_SOURCE_BASELINE="$root/server/deployments/partial-linked-posting-20261027/live-before"
export DISPATCH_SOURCE_MIGRATIONS="$DISPATCH_SOURCE_RUNTIME/migrations"
exec python3 "$root/docker/retention/retention.py" run --root /tmp/mbbs-partial-linked-posting -- \
  bash "$root/docker/run-dispatch-source-tests.sh" node tools/partial-linked-posting-all.mjs "$@"
