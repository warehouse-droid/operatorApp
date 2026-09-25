#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
release_root="${CHILD_LOCATION_RELEASE_ROOT:-/home/ubuntu/operatorapp-deploy-backups/child-location-20260918-v1}"
candidate_root="${CHILD_LOCATION_SOURCE_ROOT:-$release_root/candidate}"
baseline_root="${CHILD_LOCATION_BASELINE_ROOT:-$release_root/baseline}"
runner=(bash server/tools/child-location-test.sh)
artifact=server/test-artifacts
for kind in baseline candidate; do
  source_root="$baseline_root"
  if [[ "$kind" == candidate ]]; then source_root="$candidate_root"; fi
  CHILD_LOCATION_SOURCE_ROOT="$source_root" "${runner[@]}" node /workspace/server/tools/child-location-static.mjs "live-$kind"
  set +e
  CHILD_LOCATION_SOURCE_ROOT="$source_root" "${runner[@]}" npm test > "$artifact/child-location-$kind-full-final.log" 2>&1
  status=$?
  set -e
  if [[ "$status" -gt 1 ]]; then exit "$status"; fi
done
python3 server/tools/child-location-compare.py "$artifact/child-location-baseline-full-final.log" "$artifact/child-location-candidate-full-final.log" "$artifact/child-locations/full-comparison.json"
CHILD_LOCATION_SOURCE_ROOT="$candidate_root" "${runner[@]}" node_modules/.bin/c8 --all=false --check-coverage=false \
  '--include=src/outbound-location-*.js' '--include=src/item-fulfillment-parts-*.js' \
  '--include=src/operator-netsuite-posting-*.js' '--include=src/sales-order-auto-fulfillment-*.js' \
  --reporter=text --reporter=json --reporter=json-summary --temp-directory=/tmp/child-location-coverage \
  --report-dir=test-artifacts/child-locations/coverage node tools/child-location-focused.mjs --reverse > "$artifact/child-location-candidate-focused-final.log" 2>&1
CHILD_LOCATION_SOURCE_ROOT="$candidate_root" "${runner[@]}" node /workspace/server/tools/child-location-mutations.mjs > "$artifact/child-location-mutations.log" 2>&1
docker run --rm --network none --ipc=host -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e DISPLAY_TEST_ARTIFACTS=/app/test-artifacts/child-locations/browser \
  -v "$repo_root/server/test-artifacts/schedule-columns/browser-cache:/ms-playwright:ro" \
  -v "$candidate_root/src:/app/src:ro" -v "$candidate_root/public:/app/public:ro" \
  -v "$repo_root/server/test:/app/test:ro" -v "$repo_root/server/test-artifacts:/app/test-artifacts" \
  --entrypoint node mbbs-return-batch-browser-test:20260918 test/dispatch/frontend/operator-display-settings.browser.test.mjs > "$artifact/child-location-browser.log" 2>&1
docker run --rm --network none --ipc=host -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -v "$repo_root/server/test-artifacts/schedule-columns/browser-cache:/ms-playwright:ro" \
  -v "$candidate_root/public:/app/public:ro" -v "$repo_root/server/tools:/app/tools:ro" \
  -v "$repo_root/server/test-artifacts:/app/test-artifacts" --entrypoint node mbbs-return-batch-browser-test:20260918 \
  tools/child-location-browser.mjs > "$artifact/child-location-results-browser.log" 2>&1
docker run --rm --network none -v "$candidate_root/src:/app/src:ro" -v "$candidate_root/public:/app/public:ro" \
  -v "$candidate_root/migrations:/app/migrations:ro" -v "$repo_root/server/tools:/app/tools:ro" -v "$repo_root/server/test:/app/test:ro" \
  -v "$repo_root/server/test-artifacts:/app/test-artifacts" -v "$release_root:/release:ro" \
  --entrypoint node mbbs-retired-confirm-test:20260914 tools/child-location-evidence.mjs
