#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${MBT_TEST_ISOLATED:-}" != "1" ]]; then
  echo "Dispatch performance gauntlet requires MBT_TEST_ISOLATED=1." >&2
  exit 70
fi
if [[ "${MBT_MUTATION_EPHEMERAL:-}" != "1" ]]; then
  echo "Dispatch performance gauntlet requires a writable ephemeral source copy." >&2
  exit 70
fi

echo "[dispatch-gauntlet] focused unit, property, adversarial, frontend, integration, and concurrency tests"
npm run test:dispatch:performance

echo "[dispatch-gauntlet] focused coverage"
npm run coverage:dispatch:performance

echo "[dispatch-gauntlet] static checks"
npm run lint:dispatch:performance
npm run syntax:legacy

echo "[dispatch-gauntlet] focused mutation set"
npm run mutate:dispatch:performance

echo "[dispatch-gauntlet] dependency licenses and changed-source secret scan"
npm run licenses:mbt
node test/support/scan-diff-secrets.mjs \
  src/dispatch-planner-performance.js \
  src/dispatch-planner-v2-repository.js \
  test/dispatch \
  tools/dispatch-performance-gauntlet.sh

echo "[dispatch-gauntlet] complete"
