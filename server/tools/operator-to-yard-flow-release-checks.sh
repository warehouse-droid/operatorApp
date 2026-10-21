#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
artifact="$repo/server/test-artifacts/operator-to-yard-flow-deployment"
label="${TO_YARD_RELEASE_LABEL:-partial}"
[[ "$label" == partial || "$label" == terminal ]]
bash server/tools/operator-to-yard-flow-test.sh sh -c '
  node node_modules/c8/bin/c8.js --all=false --check-coverage=false \
    --include="src/transfer-order-posting-*.js" --include=src/receiving-repository.js --include=src/delivery-repository.js \
    --include="tools/operator-to-yard-flow-reconcil*.mjs" \
    --temp-directory=/tmp/to-release-c8 \
    --report-dir=test-artifacts/operator-to-yard-flow-deployment/partial-release-coverage \
    --reporter=json --reporter=text-summary node --test --test-concurrency=1 \
    test/mbt/integration/operator-to-yard-flow.test.js \
    test/mbt/integration/operator-receiving-allocations.test.js \
    test/mbt/integration/operator-receiving-completed.test.js \
    test/mbt/integration/transfer-order-background-posting.test.js \
    test/mbt/integration/to-linked-so-completion.test.js \
    test/mbt/unit/transfer-order-background-posting.test.js \
    test/mbt/property/operator-to-yard-flow.property.test.js \
    test/mbt/unit/operator-to-yard-flow-reconciliation.test.js \
    test/mbt/unit/operator-to-yard-flow-reconciliation-proof.test.js \
    test/mbt/integration/operator-to-yard-flow-reconciliation.test.js \
    test/mbt/integration/operator-to-legacy-receiving.test.js &&
  node tools/operator-to-yard-flow-reconciliation-mutations.mjs &&
  node tools/operator-to-partial-receiving-mutations.mjs &&
  node --check src/receiving-repository.js
' > "$artifact/candidate-$label-tests.log" 2>&1
python3 server/tools/operator-to-yard-flow-reconciliation-static.py check > "$artifact/release-maintenance-lint.log" 2>&1
python3 -m py_compile server/tools/operator-to-yard-flow-*.py server/tools/operator-to-*-receiving-deploy.py
