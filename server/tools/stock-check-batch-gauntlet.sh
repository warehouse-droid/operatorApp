#!/usr/bin/env bash
set -euo pipefail
stock_batch_server=$(cd "$(dirname "$0")/.." && pwd)
cd "$stock_batch_server"
export STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-batch-20261015/candidate
export STOCK_CHECK_RUNTIME_IMAGE=mbbs-operator-app:stock-check-batch-20261015
export STOCK_CHECK_TEST_ARTIFACTS="$stock_batch_server/test-artifacts/stock-check-batch"
export STOCK_CHECK_REGRESSION_FILE=test/mbt/integration/backorder-requests.test.js
if [[ "${1:-}" != --checks-only ]]; then
  python3 -c 'import json,pathlib,time; pathlib.Path("test-artifacts/stock-check-batch/gauntlet-start.json").write_text(json.dumps({"started":time.time()})+"\n")'
fi
for stock_batch_stage in static-batch-final ollama-properties-batch-final batch-mutations-final final-batch full-batch-backorder boot-batch; do
  bash tools/stock-check-tests.sh "$stock_batch_stage"
done
if [[ "${1:-}" != --checks-only ]]; then
  bash tools/stock-check-batch-history.sh
  bash tools/stock-check-batch-history.sh --request
  python3 tools/stock-check-batch-evidence.py
fi
