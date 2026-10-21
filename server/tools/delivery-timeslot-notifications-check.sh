#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
phase="${1:-final}"
artifact="$repo_root/server/test-artifacts/delivery-timeslot-notifications-20261014/$phase"
mkdir -p "$artifact"
export DELIVERY_ENHANCEMENTS_ARTIFACT="$artifact"
export DELIVERY_ENHANCEMENTS_PROJECT="mbbs-delivery-timeslot-notifications-$phase"
if [[ "$phase" == final ]]; then
  bash "$repo_root/server/tools/delivery-request-enhancements-test.sh" node node_modules/c8/bin/c8.js \
    --all=false --include=src/delivery-request-domain.js --include=src/delivery-request-repository.js \
    --reporter=json --reporter=json-summary --reporter=text-summary --reports-dir=test-artifacts/coverage \
    node tools/delivery-timeslot-notifications-checks.mjs "$phase" 2>&1 | tee "$artifact/run.log"
else
  bash "$repo_root/server/tools/delivery-request-enhancements-test.sh" node tools/delivery-timeslot-notifications-checks.mjs "$phase" \
    2>&1 | tee "$artifact/run.log"
fi
