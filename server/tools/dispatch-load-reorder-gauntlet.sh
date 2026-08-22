#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${MBT_TEST_ISOLATED:-}" != "1" ]]; then
  echo "Dispatch load-reorder gauntlet requires MBT_TEST_ISOLATED=1." >&2
  exit 70
fi
if [[ "${MBT_MUTATION_EPHEMERAL:-}" != "1" ]]; then
  echo "Dispatch load-reorder gauntlet requires a writable disposable source copy." >&2
  exit 70
fi

echo "[dispatch-load-reorder] executable position and 6,400-move stress specification"
npm run test:dispatch-load-reorder

echo "[dispatch-load-reorder] existing timing and driver-order regressions"
npm run test:dispatch-start-time
npm run test:dispatch-driver-order

echo "[dispatch-load-reorder] syntax, lint, and static types"
npm run syntax:legacy
npm run lint:dispatch-load-reorder
npm run typecheck:mbt

echo "[dispatch-load-reorder] six critical mutations"
npm run mutate:dispatch-load-reorder

echo "[dispatch-load-reorder] licenses, focused secret scan, and source state"
npm run licenses:mbt
npm run secrets:dispatch-load-reorder
bash tools/dispatch-load-reorder-source-state.sh

echo "[dispatch-load-reorder] complete (run the separate Playwright save/reload check against the isolated runtime stack)"
