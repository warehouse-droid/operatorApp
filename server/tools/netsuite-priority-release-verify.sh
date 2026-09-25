#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release="$server_root/test-artifacts/netsuite-priority-deployment-20260925"
cd "$server_root"
sudo -n env NETSUITE_PRIORITY_SOURCE_ROOT="$release/candidate-app" \
  NETSUITE_PRIORITY_ARTIFACT_ROOT="$release/checks-app" \
  bash tools/netsuite-priority-release-test.sh node tools/netsuite-priority-queue-checks.mjs \
  > "$release/release-checks.log" 2>&1
sudo -n env NETSUITE_PRIORITY_SOURCE_ROOT="$release/candidate-webhook-worker" \
  NETSUITE_PRIORITY_ARTIFACT_ROOT="$release/checks-worker" \
  bash tools/netsuite-priority-release-test.sh node --test --test-concurrency=1 \
  test/mbt/integration/netsuite-priority-queue.test.js \
  test/mbt/integration/netsuite-priority-queue-process.test.js \
  test/mbt/integration/netsuite-priority-queue-failure.test.js \
  test/mbt/unit/operator-direct-orderline-pool.test.js \
  test/mbt/integration/p2-netsuite-production-transport.test.js \
  > "$release/worker-tests.log" 2>&1
python3 tools/netsuite-priority-release-smoke.py
python3 tools/netsuite-priority-release-evidence.py
