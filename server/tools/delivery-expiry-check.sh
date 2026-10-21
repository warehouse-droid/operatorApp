#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
phase="${1:-final}"
artifact="$repo_root/server/test-artifacts/delivery-expiry-20261016/$phase"
mkdir -p "$artifact"
export DELIVERY_ENHANCEMENTS_ARTIFACT="$artifact"
export DELIVERY_ENHANCEMENTS_PROJECT="mbbs-delivery-expiry-$phase"
export DELIVERY_UI_COVERAGE=1
python3 "$repo_root/server/tools/delivery-expiry-sources.py"
if [[ "$phase" == final ]]; then
  bash "$repo_root/server/tools/delivery-request-enhancements-test.sh" bash -c '
    set -e
    node node_modules/c8/bin/c8.js --all=false --check-coverage=false --include=src/delivery-request-domain.js --include=src/delivery-request-repository.js --include=public/delivery-request-expiry-time.js --reporter=json --reporter=json-summary --reporter=text-summary --reports-dir=test-artifacts/coverage node tools/delivery-expiry-check.mjs final
    node tools/delivery-expiry-mutations.mjs
    node tools/delivery-expiry-coverage.mjs
  ' > "$artifact/run.log" 2>&1
else
  bash "$repo_root/server/tools/delivery-request-enhancements-test.sh" node tools/delivery-expiry-check.mjs "$phase" > "$artifact/run.log" 2>&1
fi
