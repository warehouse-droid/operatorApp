#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${DRIVER_ROUTE_PREFIX_GAUNTLET_INNER:-}" != "1" ]]; then
  server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  repo_root="$(cd "${server_root}/.." && pwd)"
  compose=(docker compose -f "${repo_root}/docker-compose.mbt-test.yml" --profile tools)
  cd "${repo_root}"
  "${compose[@]}" run --rm --build \
    -e DRIVER_ROUTE_PREFIX_GAUNTLET_INNER=1 \
    test bash tools/driver-live-route-prefix-lock-gauntlet.sh
  "${compose[@]}" run --rm --build \
    -e MBT_MUTATION_EPHEMERAL=1 \
    mutation node test/support/run-dispatch-active-load-mutations.mjs
  exit 0
fi

node --check src/driver-route-cursor.js
node --check src/dispatch-executed-prefix-repository.js
node --check src/dispatch-planner-performance.js
node --check src/driver-repository.js
node --check public/driver.js

node --test --test-concurrency=1 \
  test/mbt/unit/driver-live-route-prefix-lock.red.test.js \
  test/mbt/unit/driver-live-route-prefix-lock-wiring.contract.test.js \
  test/mbt/unit/driver-offline-route-cursor.red.test.js \
  test/mbt/property/driver-live-route-prefix-lock.property.test.js \
  test/mbt/adversarial/driver-live-route-prefix-lock.adversarial.test.js \
  test/mbt/integration/driver-live-route-prefix-lock.integration.test.js \
  test/mbt/concurrency/driver-live-route-prefix-lock.concurrency.test.js

npx c8 --all=false --include=src/driver-route-cursor.js \
  --temp-directory=/tmp/driver-route-prefix-c8 \
  --report-dir=test-artifacts/driver-live-route-prefix-lock/coverage \
  --reporter=text --reporter=json-summary \
  node --test --test-concurrency=1 \
    test/mbt/unit/driver-live-route-prefix-lock.red.test.js \
    test/mbt/adversarial/driver-live-route-prefix-lock.adversarial.test.js

npx eslint --config eslint.mbt.config.js --max-warnings=0 \
  src/driver-route-cursor.js \
  src/dispatch-executed-prefix-repository.js \
  src/dispatch-plan-repository.js \
  src/dispatch-repository.js \
  src/delivery-repository.js \
  src/dispatch-co-group-identity-repository.js \
  src/dispatch-co-cargo-repair.js \
  src/mbt/bin-dispatch-service.js \
  src/sales-order-reconciliation-repository.js \
  src/sales-order-reconciliation-integration-harness.js \
  src/grouped-sales-order-reconciliation-integration-harness.js \
  test/support/driver-live-route-prefix-lock-fixture.mjs \
  test/mbt/unit/driver-live-route-prefix-lock.red.test.js \
  test/mbt/unit/driver-live-route-prefix-lock-wiring.contract.test.js \
  test/mbt/unit/driver-offline-route-cursor.red.test.js \
  test/mbt/property/driver-live-route-prefix-lock.property.test.js \
  test/mbt/adversarial/driver-live-route-prefix-lock.adversarial.test.js \
  test/mbt/integration/driver-live-route-prefix-lock.integration.test.js \
  test/mbt/concurrency/driver-live-route-prefix-lock.concurrency.test.js \
  tools/driver-live-route-prefix-lock-replay.mjs

node tools/driver-live-route-prefix-lock-replay.mjs
