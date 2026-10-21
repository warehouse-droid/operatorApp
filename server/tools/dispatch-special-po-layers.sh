#!/usr/bin/env bash
set -Eeuo pipefail
node tools/dispatch-special-po-mutations.mjs > test-artifacts/mutations.log 2>&1
node node_modules/c8/bin/c8.js --all=false --check-coverage=false \
  --include=src/dispatch-po-route-projection.js --include=src/dispatch-history-mode.js \
  --include=src/dispatch-completion-repository.js \
  --temp-directory=/tmp/special-po-c8 --report-dir=test-artifacts/coverage \
  --reporter=text --reporter=json --reporter=json-summary \
  node --test --test-concurrency=1 \
  test/dispatch/unit/dispatch-special-po-lifecycle.test.js \
  test/dispatch/property/dispatch-special-po-lifecycle.test.js \
  test/dispatch/integration/dispatch-special-po-lifecycle.test.js \
  test/dispatch/unit/dispatch-po-route-residual.red.test.js \
  test/dispatch/property/dispatch-po-route-residual.property.test.js \
  test/dispatch/adversarial/dispatch-po-route-residual-adversarial.test.js \
  test/mbt/integration/dispatch-completion-status.red.test.js > test-artifacts/coverage.log 2>&1
node tools/dispatch-special-po-static.mjs > test-artifacts/static.log 2>&1
node test/support/scan-diff-secrets.mjs src/dispatch-po-route-projection.js \
  src/dispatch-history-mode.js src/dispatch-completion-repository.js \
  migrations/213_dispatch_special_po_link_coverage.sql > test-artifacts/secrets.log 2>&1
