#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
compose=(docker compose -p mbbs-mbt-p1-test -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Dispatch runtime-resilience gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi

cleanup_test_stack() {
  "${compose[@]}" --profile tools --profile runtime --profile e2e \
    down --volumes --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup_test_stack EXIT INT TERM
cd "${repo_root}"

echo "[dispatch-runtime] build pinned disposable test images"
"${compose[@]}" --profile tools --profile runtime --profile e2e build test mutation app e2e

echo "[dispatch-runtime] recreate disposable PostgreSQL and apply every migration"
cleanup_test_stack
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[dispatch-runtime] exact incident, property, performance, and UI regressions"
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 \
    test/dispatch/frontend/dispatch-runtime-resilience.red.test.js \
    test/dispatch/property/dispatch-edit-lease-session.property.test.js \
    test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
    test/dispatch/frontend/dispatch-completion-ui.test.js
"${compose[@]}" --profile tools run --rm test node src/dispatch-driver-order-harness.js
"${compose[@]}" --profile tools run --rm test node src/operator-camera-schedule-harness.js
"${compose[@]}" --profile tools run --rm test node src/operator-return-ui-harness.js

echo "[dispatch-runtime] full Node and legacy application suites"
"${compose[@]}" --profile tools run --rm test npm run test:mbt
"${compose[@]}" --profile tools run --rm baseline npm run test:baseline:mbt:full

echo "[dispatch-runtime] reverse-order focused repeat for order-dependence"
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 \
    test/dispatch/frontend/dispatch-completion-ui.test.js \
    test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
    test/dispatch/property/dispatch-edit-lease-session.property.test.js \
    test/dispatch/frontend/dispatch-runtime-resilience.red.test.js

echo "[dispatch-runtime] syntax, static types, lint, and complexity checks"
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    test/dispatch/frontend/dispatch-runtime-resilience.red.test.js \
    test/dispatch/property/dispatch-edit-lease-session.property.test.js \
    test/mbt/e2e/dispatch-edit-lease-resume.spec.js \
    test/support/run-dispatch-runtime-resilience-mutations.mjs

echo "[dispatch-runtime] persisted five-mutant critical set"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation node test/support/run-dispatch-runtime-resilience-mutations.mjs

echo "[dispatch-runtime] dependency tree, licenses, and focused secret scan"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test npm run licenses:mbt
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    public/dispatch.html \
    public/dispatch.js \
    public/service-worker.js \
    src/dispatch-driver-order-harness.js \
    test/dispatch/frontend/dispatch-runtime-resilience.red.test.js \
    test/dispatch/property/dispatch-edit-lease-session.property.test.js \
    test/mbt/e2e/dispatch-edit-lease-resume.spec.js \
    test/mbt/e2e/dispatch-popup-render-boundary.spec.js \
    test/mbt/infrastructure/p3-gauntlet-contract.test.js \
    test/support/p3-mutation-manifest.mjs \
    test/support/run-dispatch-runtime-resilience-mutations.mjs \
    tools/dispatch-runtime-resilience-gauntlet.sh \
    tools/dispatch-runtime-resilience-source-state.sh

echo "[dispatch-runtime] recreate clean database for production-image browser execution"
cleanup_test_stack
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate
"${compose[@]}" --profile runtime --profile e2e up -d --wait app

echo "[dispatch-runtime] full Chromium desktop/mobile and mobile WebKit suite"
"${compose[@]}" --profile runtime --profile e2e run --rm e2e npm run test:mbt:e2e

echo "[dispatch-runtime] source state"
"${server_root}/tools/dispatch-runtime-resilience-source-state.sh"

echo "[dispatch-runtime] complete"
