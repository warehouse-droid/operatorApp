#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-dispatch-co-gauntlet"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Dispatch CO gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools down --remove-orphans >/dev/null 2>&1 || true
}
reset_database() {
  "${compose[@]}" --profile tools down --remove-orphans >/dev/null 2>&1 || true
  "${compose[@]}" up -d --wait db
  "${compose[@]}" --profile tools run --rm migrate
}
trap cleanup EXIT
cd "${repo_root}"

echo "[dispatch-co] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools build test mutation
reset_database

echo "[dispatch-co] focused lifecycle, recovery, property, and concurrency suite"
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-co-lifecycle
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 \
    test/mbt/integration/migration-upgrade.test.js \
    test/mbt/integration/p3-predeploy-readiness.test.js

echo "[dispatch-co] related Dispatch regression suites"
"${compose[@]}" --profile tools run --rm test npm run test:dispatch:performance
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-load-assignments-integration
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-links

echo "[dispatch-co] syntax, lint, and type checks"
"${compose[@]}" --profile tools run --rm test node --check src/dispatch-co-lifecycle.js
"${compose[@]}" --profile tools run --rm test node --check src/dispatch-co-recovery.js
"${compose[@]}" --profile tools run --rm test node --check public/dispatch.js
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    public/dispatch.js \
    src/dispatch-co-lifecycle.js \
    src/dispatch-co-recovery.js \
    src/dispatch-plan-repository.js \
    src/dispatch-planner-performance.js \
    src/dispatch-planner-v2-repository.js \
    src/dispatch-repository.js \
    src/receiving-repository.js \
    src/server.js \
    test/dispatch/frontend/dispatch-co-global-lifecycle.contract.test.js \
    test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js \
    test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js \
    test/dispatch/integration/dispatch-co-recovery.test.js \
    test/mbt/integration/migration-upgrade.test.js \
    test/mbt/integration/p3-predeploy-readiness.test.js \
    test/dispatch/property/dispatch-performance-command.property.test.js \
    test/dispatch/unit/dispatch-co-lifecycle-wiring.test.js \
    test/dispatch/unit/dispatch-performance-contract.test.js \
    test/support/check-dispatch-co-lifecycle-coverage.mjs \
    test/support/run-dispatch-co-lifecycle-mutations.mjs
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt

echo "[dispatch-co] changed-line execution evidence"
reset_database
"${compose[@]}" --profile tools run --rm test npm run coverage:dispatch-co-lifecycle
"${compose[@]}" --profile tools run --rm test \
  node test/support/check-dispatch-co-lifecycle-coverage.mjs \
    test-artifacts/dispatch-co-lifecycle-coverage/coverage-final.json

echo "[dispatch-co] critical mutation set"
reset_database
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:dispatch-co-lifecycle

echo "[dispatch-co] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    Dockerfile \
    migrations/191_driver_completed_co_lifecycle.sql \
    package.json \
    public/dispatch.js \
    src/dispatch-co-lifecycle.js \
    src/dispatch-co-recovery.js \
    src/dispatch-plan-repository.js \
    src/dispatch-planner-performance.js \
    src/dispatch-planner-v2-repository.js \
    src/dispatch-repository.js \
    src/receiving-repository.js \
    src/server.js \
    test/dispatch-co-global-lifecycle-evidence.md \
    test/dispatch-co-global-lifecycle-spec.md \
    test/dispatch/frontend/dispatch-co-global-lifecycle.contract.test.js \
    test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js \
    test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js \
    test/dispatch/integration/dispatch-co-recovery.test.js \
    test/dispatch/property/dispatch-performance-command.property.test.js \
    test/dispatch/unit/dispatch-co-lifecycle-wiring.test.js \
    test/dispatch/unit/dispatch-performance-contract.test.js \
    test/support/check-dispatch-co-lifecycle-coverage.mjs \
    test/support/run-dispatch-co-lifecycle-mutations.mjs \
    tools/mbt-predeploy-readiness.mjs \
    tools/dispatch-co-lifecycle-gauntlet.sh \
    tools/dispatch-co-lifecycle-source-state.sh \
    tools/recover-co-goa-3464-3470-6922.js
bash "${server_root}/tools/dispatch-co-lifecycle-source-state.sh"
echo "[dispatch-co] complete"
