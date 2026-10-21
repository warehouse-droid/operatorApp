#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
phase="${1:-final}"
artifact="${ATTENTION_ARTIFACT:-$repo_root/server/test-artifacts/app-notification-attention-20261014/$phase}"
mkdir -p "$artifact"
export DELIVERY_ENHANCEMENTS_ARTIFACT="$artifact"
export DELIVERY_ENHANCEMENTS_PROJECT="${ATTENTION_PROJECT:-mbbs-app-notification-attention-$phase}"
if [[ "$phase" == red || "$phase" == green ]]; then export DELIVERY_ENHANCEMENTS_SKIP_DB=1; fi
bash "$repo_root/server/tools/delivery-request-enhancements-test.sh" \
  node tools/app-notification-attention-checks.mjs "$phase" 2>&1 | tee "$artifact/run.log"
