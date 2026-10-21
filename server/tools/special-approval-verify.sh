#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 tools/special-approval-diff.py
sudo -n docker exec -e MBT_TEST_ISOLATED=1 -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify -e PLAYWRIGHT_BROWSERS_PATH=/browsers -w /app mbbs-special-review-runner node tools/special-approval-migrate.mjs
sudo -n docker exec -e MBT_TEST_ISOLATED=1 -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify -e PLAYWRIGHT_BROWSERS_PATH=/browsers -w /app mbbs-special-review-runner node tools/special-approval-check.mjs
