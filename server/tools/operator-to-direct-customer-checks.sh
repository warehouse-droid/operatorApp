#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
export TO_YARD_CANDIDATE_ROOT="${TO_YARD_CANDIDATE_ROOT:-/home/ubuntu/operatorapp-deploy-backups/to01208-delivery-prep/direct-release/candidate}"
bash server/tools/operator-to-yard-flow-test.sh sh -c '
  node node_modules/c8/bin/c8.js --all=false --check-coverage=false \
    --include=src/direct-to-completion-repository.js --include="src/transfer-order-posting-*.js" \
    --include=src/operator-netsuite-posting-domain.js --include=src/order-dependency-repository.js \
    --temp-directory=/tmp/direct-to-c8 --report-dir=test-artifacts/operator-to-direct-customer/coverage \
    --reporter=json --reporter=text-summary node --test --test-concurrency=1 \
    test/mbt/integration/direct-to-completion.test.js test/mbt/property/direct-to-completion.property.test.js \
    test/mbt/integration/operator-to-yard-flow.test.js test/mbt/integration/operator-receiving-allocations.test.js \
    test/mbt/integration/operator-receiving-completed.test.js test/mbt/integration/transfer-order-background-posting.test.js \
    test/mbt/integration/to-linked-so-completion.test.js test/mbt/unit/transfer-order-background-posting.test.js \
    test/mbt/property/operator-to-yard-flow.property.test.js test/mbt/unit/operator-to-yard-flow-reconciliation.test.js \
    test/mbt/unit/operator-to-yard-flow-reconciliation-proof.test.js test/mbt/integration/operator-to-yard-flow-reconciliation.test.js \
    test/mbt/integration/operator-to-legacy-receiving.test.js test/mbt/unit/operator-netsuite-posting-domain.red.test.js \
    test/mbt/unit/direct-ship-posting.test.js test/mbt/integration/direct-ship-posting.test.js &&
  node tools/operator-to-direct-customer-mutations.mjs && node tools/operator-to-direct-customer-static.mjs
' > server/test-artifacts/operator-to-direct-customer/checks.log 2>&1
python3 -m py_compile server/tools/operator-to-direct-customer-*.py
