#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 tools/special-enhancements-diff.py
sudo -n docker exec -e MBT_TEST_ISOLATED=1 \
  -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify \
  -e PLAYWRIGHT_BROWSERS_PATH=/browsers \
  -e SPECIAL_BROWSER_ARTIFACTS=test-artifacts/special-workflow-review/request-enhancements-20260928/approval-browser \
  -w /app mbbs-special-review-runner node tools/special-enhancements-check.mjs
