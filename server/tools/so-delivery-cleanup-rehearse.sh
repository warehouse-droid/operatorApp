#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
base=server/test-artifacts/so-delivery-cleanup-apply-20260915
for scope in live local; do
  manifest_hash="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sha256"])' "$base/$scope/summary.json")"
  for mode in apply verify; do
    bash server/tools/so-delivery-cleanup-isolated.sh run node tools/so-delivery-cleanup-cli.mjs \
      "$mode" "test-artifacts/so-delivery-cleanup-apply-20260915/$scope" "$manifest_hash" > "$base/$scope/clone-$mode.log" 2>&1
  done
done
co_hash="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sha256"])' "$base/live/co-summary.json")"
for mode in apply verify; do
  bash server/tools/so-delivery-cleanup-isolated.sh run node tools/co-source-cleanup-cli.mjs \
    "$mode" test-artifacts/so-delivery-cleanup-apply-20260915/live "$co_hash" > "$base/live/co-clone-$mode.log" 2>&1
done
bash server/tools/so-delivery-cleanup-isolated.sh run node tools/so-delivery-cleanup-today-read.mjs \
  test-artifacts/so-delivery-cleanup-apply-20260915/today-after.json > "$base/today-after-final.log" 2>&1
CLEANUP_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest bash server/tools/so-delivery-cleanup-isolated.sh run node \
  tools/so-delivery-cleanup-pwa-replay.mjs > "$base/pwa-replay-final.log" 2>&1
