#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
baseline="test-artifacts/dispatch-pickup-override/baseline"
if [[ ! -d "$baseline" ]]; then
  mkdir -p "$baseline/public" "$baseline/src"
  cp public/dispatch.js public/dispatch.html "$baseline/public/"
  cp src/dispatch-pickup-visits.js src/scm-dependency-plan-reconciler.js "$baseline/src/"
  patch --batch --fuzz=0 -R -p1 -d "$baseline" < test/dispatch-pickup-address.changes.patch
fi
BIN_PLANNING_CHECK=pickup-override-final bash tools/bin-planning-test.sh \
  node node_modules/c8/bin/c8.js --all=false --check-coverage=false \
  --include=src/dispatch-pickup-visits.js --include=src/scm-dependency-plan-reconciler.js \
  --temp-directory=test-artifacts/pickup-override/c8 --reporter=json \
  --reports-dir=test-artifacts/pickup-override/coverage \
  node tools/dispatch-pickup-address-check.mjs all \
  > test-artifacts/dispatch-pickup-override/final.log 2>&1
python3 tools/dispatch-pickup-address-evidence.py \
  test-artifacts/mbt-bin-planning/checks/pickup-override-final/pickup-override
