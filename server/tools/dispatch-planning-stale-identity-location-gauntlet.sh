#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-dispatch-stale-identity-location-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")
mutation_dir=""

cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ "${mutation_dir}" == /tmp/dispatch-planning-mutation.* && -d "${mutation_dir}" ]]; then
    rm -rf -- "${mutation_dir}"
  fi
}
trap cleanup EXIT
cd "${repo_root}"

cleanup
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile tools build test
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[dispatch stale identity/location] focused behavior"
"${compose[@]}" --profile tools run --rm --no-deps test node src/dispatch-custom-order-harness.js
"${compose[@]}" --profile tools run --rm --no-deps test node --test --test-concurrency=1 \
  test/workload/integration/netsuite-order-webhook-queue.red.test.js
"${compose[@]}" --profile tools run --rm --no-deps test node --test --test-concurrency=1 \
  test/dispatch/integration/dispatch-v2-snapshot-performance.red.test.js

echo "[dispatch stale identity/location] broader suites"
"${compose[@]}" --profile tools run --rm --no-deps test npm run test:application-workload
"${compose[@]}" --profile tools run --rm --no-deps test npm run test:mbt

echo "[dispatch stale identity/location] coverage"
"${compose[@]}" --profile tools run --rm --no-deps test sh -lc '
  rm -rf /tmp/dispatch-planning-stale-c8 /app/test-artifacts/dispatch-planning-stale-coverage
  npx c8 --config=test/support/c8.dispatch-planning-stale-identity-location.json \
    --clean=true --reporter=none \
    --temp-directory=/tmp/dispatch-planning-stale-c8 \
    node src/dispatch-custom-order-harness.js
  npx c8 --config=test/support/c8.dispatch-planning-stale-identity-location.json \
    --clean=false --reporter=none \
    --temp-directory=/tmp/dispatch-planning-stale-c8 \
    node --test --test-concurrency=1 test/workload/integration/netsuite-order-webhook-queue.red.test.js
  npx c8 report --config=test/support/c8.dispatch-planning-stale-identity-location.json \
    --temp-directory=/tmp/dispatch-planning-stale-c8 \
    --report-dir=/app/test-artifacts/dispatch-planning-stale-coverage \
    --reporter=text --reporter=json
  node test/support/check-dispatch-planning-stale-identity-location-coverage.mjs \
    /app/test-artifacts/dispatch-planning-stale-coverage/coverage-final.json
'

echo "[dispatch stale identity/location] syntax, types, and lint"
"${compose[@]}" --profile tools run --rm --no-deps test node --check src/dispatch-custom-order-repository.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check src/netsuite-order-webhook-queue-repository.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check test/support/run-dispatch-planning-stale-identity-location-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test node --check test/support/check-dispatch-planning-stale-identity-location-coverage.mjs
"${compose[@]}" --profile tools run --rm --no-deps test npx eslint --config eslint.mbt.config.js --max-warnings=0 \
  src/dispatch-custom-order-repository.js \
  src/dispatch-custom-order-harness.js \
  src/netsuite-order-webhook-queue-repository.js \
  test/workload/integration/netsuite-order-webhook-queue.red.test.js \
  test/support/check-dispatch-planning-stale-identity-location-coverage.mjs \
  test/support/run-dispatch-planning-stale-identity-location-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test npm run typecheck:mbt

echo "[dispatch stale identity/location] manual mutation"
mutation_dir="$(mktemp -d /tmp/dispatch-planning-mutation.XXXXXX)"
cp "${server_root}/src/dispatch-custom-order-repository.js" "${mutation_dir}/dispatch-custom-order-repository.js"
cp "${server_root}/src/netsuite-order-webhook-queue-repository.js" "${mutation_dir}/netsuite-order-webhook-queue-repository.js"
"${compose[@]}" --profile tools run --rm --no-deps \
  -e MBT_MUTATION_EPHEMERAL=1 \
  -v "${mutation_dir}/dispatch-custom-order-repository.js:/app/src/dispatch-custom-order-repository.js" \
  -v "${mutation_dir}/netsuite-order-webhook-queue-repository.js:/app/src/netsuite-order-webhook-queue-repository.js" \
  test node test/support/run-dispatch-planning-stale-identity-location-mutations.mjs

echo "[dispatch stale identity/location] secrets and source state"
"${compose[@]}" --profile tools run --rm --no-deps test node test/support/scan-diff-secrets.mjs \
  src/dispatch-custom-order-repository.js \
  src/dispatch-custom-order-harness.js \
  src/netsuite-order-webhook-queue-repository.js \
  test/dispatch-planning-stale-identity-location-spec.md \
  test/mbt/infrastructure/p3-gauntlet-contract.test.js \
  test/mbt/integration/migration-upgrade.test.js \
  test/mbt/integration/p3-predeploy-readiness.test.js \
  test/support/c8.dispatch-planning-stale-identity-location.json \
  test/support/check-dispatch-planning-stale-identity-location-coverage.mjs \
  test/support/p3-mutation-manifest.mjs \
  test/workload/integration/netsuite-order-webhook-queue.red.test.js \
  test/support/run-dispatch-planning-stale-identity-location-mutations.mjs \
  tools/dispatch-planning-stale-identity-location-gauntlet.sh \
  tools/dispatch-planning-stale-identity-location-source-state.sh \
  tools/mbt-predeploy-readiness.mjs
"${compose[@]}" --profile tools run --rm --no-deps test bash tools/dispatch-planning-stale-identity-location-source-state.sh

echo "Dispatch stale identity/location gauntlet complete."
