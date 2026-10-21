#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
python3 server/tools/billed-order-reopen-20261015/run.py baseline
python3 server/tools/billed-order-reopen-20261015/run.py final
python3 server/tools/billed-order-reopen-20261015/coverage.py
python3 server/tools/billed-order-reopen-20261015/evidence.py
