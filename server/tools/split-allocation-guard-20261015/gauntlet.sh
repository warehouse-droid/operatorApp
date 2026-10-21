#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
python3 server/tools/split-allocation-guard-20261015/run.py red
python3 server/tools/split-allocation-guard-20261015/run.py baseline
python3 server/tools/split-allocation-guard-20261015/run.py final
python3 server/tools/split-allocation-guard-20261015/coverage.py
python3 server/tools/split-allocation-guard-20261015/evidence.py
