#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$server_root/tools/special-workflow-adjustments-diff.py"
sudo -n docker cp "$server_root/netsuite-smart-scm-picking-ticket-restlet.js" mbbs-special-review-runner:/app/netsuite-smart-scm-picking-ticket-restlet.js
sudo -n docker exec -w /app -e MBT_TEST_ISOLATED=1 \
  -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify \
  -e PLAYWRIGHT_BROWSERS_PATH=/browsers mbbs-special-review-runner node tools/special-workflow-adjustments-check.mjs
