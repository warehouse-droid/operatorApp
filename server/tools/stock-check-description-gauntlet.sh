#!/usr/bin/env bash
set -euo pipefail
stock_description_server=$(cd "$(dirname "$0")/.." && pwd)
cd "$stock_description_server"
export STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-description-20261015/candidate
export STOCK_CHECK_RUNTIME_IMAGE=mbbs-operator-app:stock-check-description-20261015
export STOCK_CHECK_TEST_ARTIFACTS="$stock_description_server/test-artifacts/stock-check-description"
export STOCK_CHECK_REGRESSION_FILE=test/mbt/integration/backorder-requests.test.js
python3 -c 'import json,pathlib,time; pathlib.Path("test-artifacts/stock-check-description/gauntlet-start.json").write_text(json.dumps({"started":time.time()})+"\n")'
bash tools/stock-check-description-history.sh
for stock_description_stage in static-description-final description-unit-final matching-description-final final-description full-description-backorder boot-description; do
  bash tools/stock-check-tests.sh "$stock_description_stage"
done
python3 tools/stock-check-description-evidence.py
