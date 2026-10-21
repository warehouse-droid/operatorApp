#!/usr/bin/env bash
set -euo pipefail
stock_gauntlet_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$stock_gauntlet_root"
python3 server/tools/stock-check-prepare.py
STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/candidate bash server/tools/stock-check-tests.sh final
STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/candidate bash server/tools/stock-check-tests.sh final-shuffled
bash server/tools/stock-check-tests.sh static
bash server/tools/stock-check-tests.sh property
bash server/tools/stock-check-tests.sh runtime-mutant
bash server/tools/stock-check-audit.sh
bash server/tools/stock-check-build.sh
STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/candidate bash server/tools/stock-check-tests.sh boot-green
set +e
STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/before bash server/tools/stock-check-tests.sh full-baseline
stock_baseline_result=$?
STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/candidate bash server/tools/stock-check-tests.sh full-candidate
stock_candidate_result=$?
set -e
STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/before STOCK_CHECK_REGRESSION_FILE=test/mbt/integration/stock-request-scroll-20261009-browser.test.js bash server/tools/stock-check-tests.sh full-repeat-baseline
STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/candidate STOCK_CHECK_REGRESSION_FILE=test/mbt/integration/stock-request-scroll-20261009-browser.test.js bash server/tools/stock-check-tests.sh full-repeat-candidate
python3 server/tools/stock-check-compare-regressions.py
python3 server/tools/stock-check-final-cleanup.py
printf 'Regression exits: baseline=%s candidate=%s (compare report defines new failures).\n' "$stock_baseline_result" "$stock_candidate_result"
