#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
phase="${1:-final}"
artifact="${PREFERENCES_ARTIFACT:-$repo_root/server/test-artifacts/app-notification-preferences-20261014/$phase}"
mkdir -p "$artifact"
export DELIVERY_ENHANCEMENTS_ARTIFACT="$artifact"
export DELIVERY_ENHANCEMENTS_PROJECT="${PREFERENCES_PROJECT:-mbbs-app-notification-preferences-$phase}"
if [[ "$phase" == green ]]; then export DELIVERY_ENHANCEMENTS_SKIP_DB=1; fi
bash "$repo_root/server/tools/delivery-request-enhancements-test.sh" \
  node tools/app-notification-preferences-checks.mjs "$phase" 2>&1 | tee "$artifact/run.log"
