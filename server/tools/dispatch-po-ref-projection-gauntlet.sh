#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${MBT_TEST_ISOLATED:-}" != "1" ]]; then
  echo "Dispatch PO-reference gauntlet requires MBT_TEST_ISOLATED=1." >&2
  exit 70
fi
if [[ "${MBT_MUTATION_EPHEMERAL:-}" != "1" ]]; then
  echo "Dispatch PO-reference gauntlet requires a writable disposable source copy." >&2
  exit 70
fi

echo "[dispatch-po-ref] focused and affected integration suite"
npm run test:dispatch-po-ref-projection

echo "[dispatch-po-ref] full Dispatch suite"
npm run test:dispatch:performance

echo "[dispatch-po-ref] changed-line execution probes"
npm run coverage:dispatch-po-ref-projection

echo "[dispatch-po-ref] syntax, lint, and static types"
node --check src/dispatch-order-catalog-repository.js
node --check src/dispatch-plan-repository.js
node --check src/dispatch-planner-v2-repository.js
node --check src/dispatch-repository.js
node --check src/server.js
node --check test/dispatch/integration/dispatch-assignment-readiness-invariant.red.test.js
npm run lint:dispatch-po-ref-projection
npm run typecheck:dispatch-po-ref-projection

echo "[dispatch-po-ref] critical mutation suite"
npm run mutate:dispatch-po-ref-projection

echo "[dispatch-po-ref] dependency, secret, and source-state boundaries"
npm run licenses:mbt
npm run secrets:dispatch-po-ref-projection
bash tools/dispatch-po-ref-projection-source-state.sh

echo "[dispatch-po-ref] complete"
