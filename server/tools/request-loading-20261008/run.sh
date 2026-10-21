#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
stage="${REQUEST_LOADING_STAGE:-candidate}"
run="${REQUEST_LOADING_RUN:-checks}"
export DELIVERY_UPDATES_SOURCE_ROOT="$root/server/deployments/request-loading-performance-20261008/$stage"
export DELIVERY_UPDATES_ARTIFACT_ROOT="$root/server/test-artifacts/request-loading-performance-20261008/$run"
export DELIVERY_UPDATES_PROJECT="mbbs-request-loading-$run"
# The existing wrapper registers its EXIT/INT/TERM teardown before creating
# anything and uses the repository's bounded isolated Compose configuration.
exec bash "$root/server/tools/delivery-request-updates-test.sh" "$@"
