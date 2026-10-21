#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
state=/home/ubuntu/operatorapp-deploy-backups/special-so-122477-20261010
artifact="$repo/server/test-artifacts/special-so-122477"
if TO_YARD_CANDIDATE_ROOT="$state/baseline/webhook-worker" bash server/tools/operator-to-yard-flow-test.sh node --test test/mbt/integration/special-so-creation-webhook.test.js > "$artifact/worker-red.log" 2>&1; then
  exit 1
fi
rg -q 'true !== false' "$artifact/worker-red.log"
TO_YARD_CANDIDATE_ROOT="$state/candidate-worker" bash server/tools/operator-to-yard-flow-test.sh node --test test/mbt/integration/special-so-creation-webhook.test.js > "$artifact/worker-webhook.log" 2>&1
