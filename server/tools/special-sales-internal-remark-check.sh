#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
runner=(sudo -n docker exec -w /app -e MBT_TEST_ISOLATED=1
  -e DATABASE_URL=postgres://mbt_test:stock_updates_test_only@mbbs-special-updates-db-20261002:5432/mbt_verify
  -e PLAYWRIGHT_BROWSERS_PATH=/browsers mbbs-special-review-runner)
python3 tools/special-sales-internal-remark-diff.py
"${runner[@]}" node tools/special-sales-internal-remark-check.mjs --baseline
"${runner[@]}" node tools/special-sales-internal-remark-check.mjs --red
"${runner[@]}" node tools/special-sales-internal-remark-check.mjs
"${runner[@]}" node tools/special-sales-internal-remark-mutations.mjs
"${runner[@]}" node tools/special-sales-internal-remark-coverage.mjs
python3 tools/special-sales-internal-remark-evidence.py
