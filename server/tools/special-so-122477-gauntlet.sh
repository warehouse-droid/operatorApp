#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
artifact="$repo/server/test-artifacts/special-so-122477"
state="$artifact/replay"
python3 server/tools/special-so-122477/prepare.py replay
TO_YARD_CANDIDATE_ROOT="$state/baseline/app" bash server/tools/operator-to-yard-flow-test.sh node tools/special-so-122477-checks.mjs baseline > "$artifact/baseline-checks.log" 2>&1
TO_YARD_CANDIDATE_ROOT="$state/candidate" bash server/tools/operator-to-yard-flow-test.sh node tools/special-so-122477-checks.mjs final > "$artifact/final-checks.log" 2>&1
SPECIAL_SO_SOURCE_CONTEXT="$state" python3 server/tools/special-so-122477-coverage.py > "$artifact/changed-coverage.log"
TO_YARD_CANDIDATE_ROOT="$state/candidate" bash server/tools/operator-to-yard-flow-test.sh node tools/special-so-122477-checks.mjs shuffled > "$artifact/shuffled-checks.log" 2>&1
TO_YARD_CANDIDATE_ROOT="$state/candidate-worker" bash server/tools/operator-to-yard-flow-test.sh node --test --test-concurrency=1 test/mbt/integration/special-so-creation-webhook.test.js > "$artifact/worker-webhook.log" 2>&1
