#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
mkdir -p server/test-artifacts/split-target
bash server/tools/dispatch-split-target-test.sh node tools/dispatch-split-target-checks.mjs
SPLIT_TARGET_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest \
  bash server/tools/dispatch-split-target-test.sh node --test test/dispatch/frontend/dispatch-split-target.browser.test.mjs \
  > server/test-artifacts/split-target/browser-final.log 2>&1
