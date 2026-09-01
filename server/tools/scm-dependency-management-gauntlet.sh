#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${MBT_TEST_ISOLATED:-}" != "1" ]]; then
  echo "SCM dependency gauntlet requires MBT_TEST_ISOLATED=1." >&2
  exit 70
fi
if [[ "${MBT_MUTATION_EPHEMERAL:-}" != "1" ]]; then
  echo "SCM dependency gauntlet requires a writable ephemeral source copy." >&2
  exit 70
fi

echo "[scm-dependency-gauntlet] focused behavior and database contracts"
npm run test:scm-dependency-management
npm run coverage:order-dependency-quantity

echo "[scm-dependency-gauntlet] static, source-state, and historical replay gates"
npm run lint:scm-dependency-management
npm run syntax:legacy
node test/support/validate-dispatch-planner-replay-artifact.mjs
bash tools/scm-dependency-management-source-state.sh

echo "[scm-dependency-gauntlet] focused mutation set"
node test/support/run-scm-dependency-management-mutations.mjs

echo "[scm-dependency-gauntlet] dependency licenses and changed-source secret scan"
npm run licenses:mbt
node test/support/scan-diff-secrets.mjs \
  migrations/173_scm_dependency_management.sql \
  src/driver-offline-repository.js \
  src/driver-offline-service.js \
  src/driver-route-change-service.js \
  src/driver-route-push.js \
  src/order-dependency-repository.js \
  src/order-dependency-quantity.js \
  src/order-dependency-harness.js \
  src/scm-dependency-command-service.js \
  src/scm-dependency-management-policy.js \
  src/scm-dependency-management-repository.js \
  src/scm-dependency-plan-reconciler.js \
  src/scm-dependency-preview-service.js \
  src/scm-dependency-search-repository.js \
  src/server.js \
  public/driver.html \
  public/driver.js \
  public/driver-service-worker.js \
  public/scm-dependency-management.html \
  public/scm-dependency-management.js \
  test/scm-dependency-management-spec.md \
  test/dispatch/integration/order-dependency-multi-to-extension.red.test.js \
  test/dispatch/integration/order-dependency-quantity-replay.red.test.js \
  test/dispatch/property/order-dependency-quantity.property.test.js \
  test/fixtures/order-dependency-quantity-replay.json \
  test/support/run-scm-dependency-management-mutations.mjs \
  tools/scm-dependency-management-gauntlet.sh \
  package.json package-lock.json

echo "[scm-dependency-gauntlet] complete"
