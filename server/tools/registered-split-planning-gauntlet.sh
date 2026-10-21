#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
release="$server_root/deployments/registered-split-planning-20261007"
artifact="$server_root/test-artifacts/registered-split-planning-20261007"
# Each wrapper registers its disposable Compose teardown before launch.
sudo -n env REGISTERED_SPLIT_SOURCE_ROOT="$release/before" REGISTERED_SPLIT_BASELINE=1 \
  bash tools/registered-split-planning-test.sh node tools/registered-split-planning-checks.mjs baseline \
  > "$artifact/baseline-run.log" 2>&1
sudo -n env REGISTERED_SPLIT_SOURCE_ROOT="$release/before" \
  bash tools/registered-split-planning-test.sh node tools/registered-split-planning-checks.mjs red \
  > "$artifact/red-final-spec-run.log" 2>&1
sudo -n env REGISTERED_SPLIT_SOURCE_ROOT="$release/candidate" \
  bash tools/registered-split-planning-test.sh sh -c \
  'node tools/registered-split-planning-checks.mjs final && node tools/registered-split-planning-mutations.mjs' \
  > "$artifact/final-run.log" 2>&1
sudo -n python3 tools/registered-split-planning-evidence.py
