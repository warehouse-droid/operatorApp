#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
# Uses the existing isolated review runner and disposable PostgreSQL fixture.
# The stock-updates runner rejects any database hostname other than this one.
test_runner=(sudo -n docker exec -w /app -e MBT_TEST_ISOLATED=1
  -e DATABASE_URL=postgres://mbt_test:stock_updates_test_only@mbbs-special-updates-db-20261002:5432/mbt_verify
  -e PLAYWRIGHT_BROWSERS_PATH=/browsers mbbs-special-review-runner)
python3 tools/special-stock-updates-diff.py
"${test_runner[@]}" node tools/special-stock-updates-check.mjs --baseline
"${test_runner[@]}" node tools/special-stock-updates-check.mjs
"${test_runner[@]}" node tools/special-stock-updates-mutations.mjs
"${test_runner[@]}" node tools/special-stock-updates-coverage.mjs
python3 tools/special-stock-updates-evidence.py
