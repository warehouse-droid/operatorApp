#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-global-order-pool-dependency-preview-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")
mutation_dir=""

cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ "${mutation_dir}" == /tmp/global-order-pool-mutation.* && -d "${mutation_dir}" ]]; then
    rm -rf -- "${mutation_dir}"
  fi
}
trap cleanup EXIT
cd "${repo_root}"

cleanup
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile tools build test
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[global pool/dependency] focused behavior and properties"
"${compose[@]}" --profile tools run --rm --no-deps test node --test --test-concurrency=1 \
  test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
  test/dispatch/property/dispatch-global-order-group-pool.property.test.js \
  test/dispatch/integration/scm-dependency-preview-blockers.red.test.js
"${compose[@]}" --profile tools run --rm --no-deps test node src/dispatch-save-coordination-harness.js

echo "[global pool/dependency] relevant broader suites"
"${compose[@]}" --profile tools run --rm --no-deps test npm run test:dispatch:planner-optimization
"${compose[@]}" --profile tools run --rm --no-deps test npm run test:scm-dependency-management
"${compose[@]}" --profile tools run --rm --no-deps test node --test --test-concurrency=1 \
  test/mbt/integration/migration-upgrade.test.js \
  test/mbt/integration/p3-predeploy-readiness.test.js

echo "[global pool/dependency] focused coverage"
"${compose[@]}" --profile tools run --rm --no-deps test sh -lc '
  rm -rf /tmp/global-order-pool-c8 /app/test-artifacts/global-order-pool-dependency-preview-coverage
  npx c8 --config=test/support/c8.global-order-pool-dependency-preview.json \
    --clean=true --reporter=none \
    --temp-directory=/tmp/global-order-pool-c8 \
    node --test --test-concurrency=1 \
      test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
      test/dispatch/property/dispatch-global-order-group-pool.property.test.js
  npx c8 --config=test/support/c8.global-order-pool-dependency-preview.json \
    --clean=false --reporter=none \
    --temp-directory=/tmp/global-order-pool-c8 \
    node --test --test-concurrency=1 \
      test/dispatch/integration/scm-dependency-preview-blockers.red.test.js
  npx c8 report --config=test/support/c8.global-order-pool-dependency-preview.json \
    --temp-directory=/tmp/global-order-pool-c8 \
    --report-dir=/app/test-artifacts/global-order-pool-dependency-preview-coverage \
    --reporter=text --reporter=json
  node test/support/check-global-order-pool-dependency-preview-coverage.mjs \
    /app/test-artifacts/global-order-pool-dependency-preview-coverage/coverage-final.json
'

echo "[global pool/dependency] syntax, lint, and types"
"${compose[@]}" --profile tools run --rm --no-deps test node --check src/dispatch-delivery-group-repository.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check src/dispatch-order-catalog-repository.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check src/scm-dependency-preview-service.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check public/dispatch.js
"${compose[@]}" --profile tools run --rm --no-deps test npx eslint --config eslint.mbt.config.js --max-warnings=0 \
  src/dispatch-delivery-group-repository.js \
  src/dispatch-order-catalog-repository.js \
  src/dispatch-planner-optimization.js \
  src/scm-dependency-preview-service.js \
  test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
  test/dispatch/integration/scm-dependency-preview-blockers.red.test.js \
  test/dispatch/property/dispatch-global-order-group-pool.property.test.js \
  test/mbt/infrastructure/p3-gauntlet-contract.test.js \
  test/support/check-global-order-pool-dependency-preview-coverage.mjs \
  test/support/p3-mutation-manifest.mjs \
  test/support/run-global-order-pool-dependency-preview-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test npm run typecheck:mbt

echo "[global pool/dependency] manual mutation"
mutation_dir="$(mktemp -d /tmp/global-order-pool-mutation.XXXXXX)"
mkdir -p "${mutation_dir}/src" "${mutation_dir}/public"
cp "${server_root}/src/dispatch-delivery-group-repository.js" "${mutation_dir}/src/"
cp "${server_root}/src/dispatch-order-catalog-repository.js" "${mutation_dir}/src/"
cp "${server_root}/src/scm-dependency-preview-service.js" "${mutation_dir}/src/"
cp "${server_root}/public/dispatch.js" "${mutation_dir}/public/"
"${compose[@]}" --profile tools run --rm --no-deps \
  -e MBT_MUTATION_EPHEMERAL=1 \
  -v "${mutation_dir}/src/dispatch-delivery-group-repository.js:/app/src/dispatch-delivery-group-repository.js" \
  -v "${mutation_dir}/src/dispatch-order-catalog-repository.js:/app/src/dispatch-order-catalog-repository.js" \
  -v "${mutation_dir}/src/scm-dependency-preview-service.js:/app/src/scm-dependency-preview-service.js" \
  -v "${mutation_dir}/public/dispatch.js:/app/public/dispatch.js" \
  test node test/support/run-global-order-pool-dependency-preview-mutations.mjs

echo "[global pool/dependency] complete isolated Node suite"
"${compose[@]}" --profile tools down --volumes --remove-orphans
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate
"${compose[@]}" --profile tools run --rm --no-deps test npm run test:mbt

echo "[global pool/dependency] secrets and source state"
"${compose[@]}" --profile tools run --rm --no-deps test node test/support/scan-diff-secrets.mjs \
  migrations/190_dispatch_global_order_groups.sql \
  public/dispatch.js \
  src/dispatch-delivery-group-repository.js \
  src/dispatch-order-catalog-repository.js \
  src/dispatch-planner-optimization.js \
  src/scm-dependency-preview-service.js \
  test/dispatch-global-order-pool-dependency-preview-spec.md \
  test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
  test/dispatch/integration/scm-dependency-preview-blockers.red.test.js \
  test/dispatch/property/dispatch-global-order-group-pool.property.test.js \
  test/mbt/infrastructure/p3-gauntlet-contract.test.js \
  test/support/check-global-order-pool-dependency-preview-coverage.mjs \
  test/support/p3-mutation-manifest.mjs \
  test/support/run-global-order-pool-dependency-preview-mutations.mjs \
  tools/global-order-pool-dependency-preview-gauntlet.sh \
  tools/global-order-pool-dependency-preview-source-state.sh
"${compose[@]}" --profile tools run --rm --no-deps test bash tools/global-order-pool-dependency-preview-source-state.sh

echo "Global order-pool/dependency-preview gauntlet complete."
