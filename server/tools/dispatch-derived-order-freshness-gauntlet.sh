#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="${MBT_DERIVED_FRESHNESS_PROJECT:-mbbs-dispatch-derived-freshness-test}"
compose=(docker compose -p "${test_project}" -f "${compose_file}")
mutation_dir=""

if [[ ! -f "${compose_file}" ]]; then
  echo "Derived-order freshness gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ ! "${test_project}" =~ ^[a-z0-9][a-z0-9_-]{2,62}$ ]]; then
  echo "Derived-order freshness gauntlet received an invalid isolated Compose project name." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools --profile runtime --profile e2e down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ "${mutation_dir}" == /tmp/dispatch-derived-freshness.* && -d "${mutation_dir}" ]]; then
    rm -rf -- "${mutation_dir}"
  fi
}
trap cleanup EXIT
cd "${repo_root}"

echo "[Derived-order freshness] fresh isolated image and database"
cleanup
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile tools build test
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[Derived-order freshness] executable lifecycle, property, and race specification"
"${compose[@]}" --profile tools run --rm --no-deps \
  -e MBT_REPLAY_ARTIFACT_PATH=/app/test-artifacts/dispatch-soa07894-event-replay.json \
  test \
  node --test --test-concurrency=1 \
    test/dispatch/integration/dispatch-derived-order-freshness.red.test.js \
    test/dispatch/integration/dispatch-soa07894-event-replay.red.test.js \
    test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js \
    test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
    test/dispatch/frontend/dispatch-authoritative-retirement.red.test.js \
    test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
    test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js \
    test/dispatch/property/dispatch-derived-order-freshness.property.test.js \
    test/dispatch/concurrency/dispatch-derived-order-retirement-concurrency.red.test.js

echo "[Derived-order freshness] related group, split, catalog, CO, and planner regressions"
"${compose[@]}" --profile tools run --rm --no-deps test \
  node --test --test-concurrency=1 \
    test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js \
    test/dispatch/integration/dispatch-order-catalog.red.test.js \
    test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js \
    test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js \
    test/dispatch/unit/dispatch-performance-contract.test.js \
    test/dispatch/property/dispatch-performance-command.property.test.js

echo "[Derived-order freshness] recorded unrelated command-flow baseline"
"${compose[@]}" --profile tools run --rm --no-deps test \
  node test/support/run-dispatch-derived-order-freshness-baseline.mjs

echo "[Derived-order freshness] changed-line execution evidence"
"${compose[@]}" --profile tools run --rm --no-deps test sh -lc '
  rm -rf /tmp/dispatch-derived-freshness-c8 /app/test-artifacts/dispatch-derived-order-freshness/coverage
  npx c8 --all=false \
    --include=src/dispatch-planner-performance.js \
    --include=src/dispatch-history-mode.js \
    --check-coverage=false \
    --temp-directory=/tmp/dispatch-derived-freshness-c8 \
    --report-dir=/app/test-artifacts/dispatch-derived-order-freshness/coverage \
    --reporter=text --reporter=json \
    node --test --test-concurrency=1 \
      test/dispatch/unit/dispatch-performance-contract.test.js \
      test/dispatch/property/dispatch-derived-order-freshness.property.test.js \
      test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js \
      test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js
  node test/support/check-dispatch-derived-order-freshness-coverage.mjs \
    /app/test-artifacts/dispatch-derived-order-freshness/coverage/coverage-final.json
'

echo "[Derived-order freshness] continuous one-page browser event replay"
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile runtime --profile e2e build app e2e
"${compose[@]}" --profile runtime up -d --wait app
"${compose[@]}" --profile runtime --profile e2e run --rm --no-deps e2e \
  npx playwright test --config test/playwright.config.mjs \
    --project=chromium-desktop \
    dispatch-soa07894-event-replay.spec.js \
    dispatch-active-co-manifest-pickup.spec.js

echo "[Derived-order freshness] syntax, lint, types, and suite-order health"
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  src/dispatch-delivery-group-repository.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  src/dispatch-history-mode.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  src/dispatch-order-catalog-repository.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  src/dispatch-plan-repository.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  src/dispatch-planner-performance.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  src/dispatch-planner-v2-repository.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  src/repair-dispatch-plan-267-rejected-readd.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  src/server.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  public/dispatch.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  test/dispatch/frontend/dispatch-planner-performance.contract.test.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  test/mbt/e2e/dispatch-active-co-manifest-pickup.spec.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  test/support/run-dispatch-derived-order-freshness-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  test/support/check-dispatch-derived-order-freshness-coverage.mjs
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  test/support/run-dispatch-derived-order-freshness-baseline.mjs
"${compose[@]}" --profile tools run --rm --no-deps test bash -n \
  tools/dispatch-derived-order-freshness-gauntlet.sh
"${compose[@]}" --profile tools run --rm --no-deps test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/dispatch-delivery-group-repository.js \
    src/dispatch-history-mode.js \
    src/dispatch-order-catalog-repository.js \
    src/dispatch-plan-repository.js \
    src/dispatch-planner-performance.js \
    src/dispatch-planner-v2-repository.js \
    src/repair-dispatch-plan-267-rejected-readd.js \
    src/server.js \
    public/dispatch.js \
    test/dispatch/frontend/dispatch-authoritative-retirement.red.test.js \
    test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
    test/dispatch/integration/dispatch-derived-order-freshness.red.test.js \
    test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js \
    test/dispatch/integration/dispatch-soa07894-event-replay.red.test.js \
    test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js \
    test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
    test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js \
    test/dispatch/unit/dispatch-performance-contract.test.js \
    test/dispatch/property/dispatch-derived-order-freshness.property.test.js \
    test/dispatch/concurrency/dispatch-derived-order-retirement-concurrency.red.test.js \
    test/mbt/e2e/dispatch-soa07894-event-replay.spec.js \
    test/mbt/e2e/dispatch-active-co-manifest-pickup.spec.js \
    test/support/check-dispatch-derived-order-freshness-coverage.mjs \
    test/support/run-dispatch-derived-order-freshness-baseline.mjs \
    test/support/run-dispatch-derived-order-freshness-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm --no-deps test \
  npx tsc --noEmit --allowJs --checkJs \
    --module NodeNext --moduleResolution NodeNext --target ES2022 \
    --types node --skipLibCheck \
    test/support/run-dispatch-derived-order-freshness-mutations.mjs \
    test/support/check-dispatch-derived-order-freshness-coverage.mjs \
    test/support/run-dispatch-derived-order-freshness-baseline.mjs
"${compose[@]}" --profile tools run --rm --no-deps test \
  node --test --test-concurrency=1 \
    test/dispatch/concurrency/dispatch-derived-order-retirement-concurrency.red.test.js \
    test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
    test/dispatch/integration/dispatch-derived-order-freshness.red.test.js \
    test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js \
    test/dispatch/integration/dispatch-soa07894-event-replay.red.test.js \
    test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js \
    test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
    test/dispatch/property/dispatch-derived-order-freshness.property.test.js

echo "[Derived-order freshness] manual mutation"
mutation_dir="$(mktemp -d /tmp/dispatch-derived-freshness.XXXXXX)"
cp "${server_root}/src/dispatch-delivery-group-repository.js" "${mutation_dir}/dispatch-delivery-group-repository.js"
cp "${server_root}/src/dispatch-order-catalog-repository.js" "${mutation_dir}/dispatch-order-catalog-repository.js"
cp "${server_root}/src/dispatch-planner-performance.js" "${mutation_dir}/dispatch-planner-performance.js"
cp "${server_root}/src/dispatch-history-mode.js" "${mutation_dir}/dispatch-history-mode.js"
cp "${server_root}/public/dispatch.js" "${mutation_dir}/dispatch.js"
"${compose[@]}" --profile tools run --rm --no-deps \
  -e MBT_MUTATION_EPHEMERAL=1 \
  -v "${mutation_dir}/dispatch-delivery-group-repository.js:/app/src/dispatch-delivery-group-repository.js" \
  -v "${mutation_dir}/dispatch-order-catalog-repository.js:/app/src/dispatch-order-catalog-repository.js" \
  -v "${mutation_dir}/dispatch-planner-performance.js:/app/src/dispatch-planner-performance.js" \
  -v "${mutation_dir}/dispatch-history-mode.js:/app/src/dispatch-history-mode.js" \
  -v "${mutation_dir}/dispatch.js:/app/public/dispatch.js" \
  test node test/support/run-dispatch-derived-order-freshness-mutations.mjs

echo "[Derived-order freshness] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm --no-deps test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm --no-deps test \
  node test/support/scan-diff-secrets.mjs \
    src/dispatch-delivery-group-repository.js \
    src/dispatch-history-mode.js \
    src/dispatch-order-catalog-repository.js \
    src/dispatch-plan-repository.js \
    src/dispatch-planner-performance.js \
    src/dispatch-planner-v2-repository.js \
    src/repair-dispatch-plan-267-rejected-readd.js \
    src/server.js \
    public/dispatch.html \
    public/dispatch.js \
    test/dispatch-co-authoritative-route-spec.md \
    test/dispatch-plan-authoritative-projection-spec.md \
    test/dispatch/frontend/dispatch-authoritative-retirement.red.test.js \
    test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
    test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js \
    test/dispatch/integration/dispatch-derived-order-freshness.red.test.js \
    test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js \
    test/dispatch/integration/dispatch-soa07894-event-replay.red.test.js \
    test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js \
    test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
    test/dispatch/property/dispatch-derived-order-freshness.property.test.js \
    test/dispatch/unit/dispatch-performance-contract.test.js \
    test/dispatch/concurrency/dispatch-derived-order-retirement-concurrency.red.test.js \
    test/mbt/e2e/dispatch-soa07894-event-replay.spec.js \
    test/mbt/e2e/dispatch-active-co-manifest-pickup.spec.js \
    test/support/check-dispatch-derived-order-freshness-coverage.mjs \
    test/support/run-dispatch-derived-order-freshness-baseline.mjs \
    test/support/run-dispatch-derived-order-freshness-mutations.mjs \
    tools/dispatch-derived-order-freshness-gauntlet.sh \
    tools/dispatch-derived-order-freshness-source-state.sh
bash "${server_root}/tools/dispatch-derived-order-freshness-source-state.sh"

echo "Derived-order freshness gauntlet complete."
