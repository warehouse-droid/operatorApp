#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$server_root/tools/special-workflow-rest-orders-diff.py"
sudo -n docker exec -w /app -e MBT_TEST_ISOLATED=1 \
  -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify \
  mbbs-special-review-runner node tools/special-workflow-rest-orders-check.mjs
