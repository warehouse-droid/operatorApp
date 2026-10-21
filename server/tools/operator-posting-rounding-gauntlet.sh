#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
artifact="$repo/server/test-artifacts/operator-posting-rounding"
state=/home/ubuntu/operatorapp-deploy-backups/operator-rounding-20261010
python3 server/tools/operator-posting-rounding-prepare.py
TO_YARD_CANDIDATE_ROOT="$state/baseline/app" bash server/tools/operator-to-yard-flow-test.sh node tools/operator-posting-rounding-checks.mjs baseline > "$artifact/baseline-checks.log" 2>&1
TO_YARD_CANDIDATE_ROOT="$state/candidate" bash server/tools/operator-to-yard-flow-test.sh node tools/operator-posting-rounding-checks.mjs final > "$artifact/final-checks.log" 2>&1
python3 server/tools/operator-posting-rounding-coverage.py > "$artifact/changed-coverage.log"
TO_YARD_CANDIDATE_ROOT="$state/candidate" bash server/tools/operator-to-yard-flow-test.sh node tools/operator-posting-rounding-checks.mjs shuffled > "$artifact/shuffled-checks.log" 2>&1
