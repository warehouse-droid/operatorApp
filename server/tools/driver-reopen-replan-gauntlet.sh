#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release="$server_root/deployments/driver-reopen-replan-20261006"
artifact="$server_root/test-artifacts/driver-reopen-replan-20261006"
cd "$server_root"
# Each invocation registers teardown before creating its isolated environment.
DRIVER_REOPEN_SOURCE_ROOT="$release/before" DRIVER_REOPEN_SKIP_DB=1 \
  bash tools/driver-reopen-replan-test.sh node tools/driver-reopen-replan-static.mjs baseline \
  > "$artifact/baseline-static.log" 2>&1
DRIVER_REOPEN_SOURCE_ROOT="$release/candidate" bash tools/driver-reopen-replan-test.sh \
  node tools/driver-reopen-replan-final.mjs > "$artifact/final.log" 2>&1
DRIVER_REOPEN_SOURCE_ROOT="$release/before" bash tools/driver-reopen-replan-test.sh \
  node tools/driver-reopen-replan-migration.mjs > "$artifact/migration-final.log" 2>&1
python3 tools/driver-reopen-replan-evidence.py
