#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-dispatch-co-authoritative-route-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")
mutation_dir=""

if [[ ! -f "${compose_file}" ]]; then
  echo "CO authoritative-route gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ "${mutation_dir}" == /tmp/dispatch-co-authoritative-route.* && -d "${mutation_dir}" ]]; then
    rm -rf -- "${mutation_dir}"
  fi
}
trap cleanup EXIT
cd "${repo_root}"

echo "[CO authoritative route] fresh isolated image and database"
cleanup
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile tools build test
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[CO authoritative route] focused executable spec"
"${compose[@]}" --profile tools run --rm --no-deps test \
  node --test --test-concurrency=1 \
    test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
    test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js \
    test/dispatch/property/dispatch-co-authoritative-route-merge.property.test.js \
    test/dispatch/property/dispatch-co-snapshot-route-authority.property.test.js

echo "[CO authoritative route] related Dispatch regression and concurrency suite"
"${compose[@]}" --profile tools run --rm --no-deps test \
  node --test --test-concurrency=1 \
    test/dispatch/frontend/dispatch-completion-ui.test.js \
    test/dispatch/frontend/dispatch-co-global-lifecycle.contract.test.js \
    test/dispatch/frontend/dispatch-po-ref-link-search.test.js \
    test/dispatch/frontend/dispatch-unplan-freshness.red.test.js \
    test/dispatch/integration/dispatch-co-group-identity-repair.red.test.js \
    test/dispatch/integration/dispatch-global-derived-http.red.test.js \
    test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
    test/dispatch/integration/dispatch-v2-snapshot-performance.red.test.js \
    test/dispatch/concurrency/dispatch-v2-stale-command.red.test.js

echo "[CO authoritative route] syntax, types, lint, and suite-order health"
"${compose[@]}" --profile tools run --rm --no-deps test node --check public/dispatch.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  test/dispatch/property/dispatch-co-authoritative-route-merge.property.test.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  test/support/run-dispatch-co-authoritative-route-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  test/support/run-dispatch-co-snapshot-route-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test bash -n \
  tools/dispatch-co-authoritative-route-gauntlet.sh
"${compose[@]}" --profile tools run --rm --no-deps test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    public/dispatch.js \
    src/dispatch-co-lifecycle.js \
    test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
    test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js \
    test/dispatch/property/dispatch-co-authoritative-route-merge.property.test.js \
    test/dispatch/property/dispatch-co-snapshot-route-authority.property.test.js \
    test/support/run-dispatch-co-authoritative-route-mutations.mjs \
    test/support/run-dispatch-co-snapshot-route-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm --no-deps test \
  npx tsc --noEmit --allowJs --checkJs \
    --module NodeNext --moduleResolution NodeNext --target ES2022 \
    --types node --skipLibCheck \
    test/support/run-dispatch-co-authoritative-route-mutations.mjs \
    test/support/run-dispatch-co-snapshot-route-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test \
  node --test --test-concurrency=2 \
    test/dispatch/property/dispatch-co-authoritative-route-merge.property.test.js \
    test/dispatch/property/dispatch-co-snapshot-route-authority.property.test.js \
    test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js \
    test/dispatch/frontend/dispatch-planner-performance.contract.test.js

echo "[CO authoritative route] manual mutation"
mutation_dir="$(mktemp -d /tmp/dispatch-co-authoritative-route.XXXXXX)"
cp "${server_root}/public/dispatch.js" "${mutation_dir}/dispatch.js"
"${compose[@]}" --profile tools run --rm --no-deps \
  -e MBT_MUTATION_EPHEMERAL=1 \
  -v "${mutation_dir}/dispatch.js:/app/public/dispatch.js" \
  test node test/support/run-dispatch-co-authoritative-route-mutations.mjs
cp "${server_root}/src/dispatch-co-lifecycle.js" "${mutation_dir}/dispatch-co-lifecycle.js"
"${compose[@]}" --profile tools run --rm --no-deps \
  -e MBT_MUTATION_EPHEMERAL=1 \
  -v "${mutation_dir}/dispatch-co-lifecycle.js:/app/src/dispatch-co-lifecycle.js" \
  test node test/support/run-dispatch-co-snapshot-route-mutations.mjs

echo "[CO authoritative route] dependency, secret, capability, and source-state boundaries"
"${compose[@]}" --profile tools run --rm --no-deps test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm --no-deps test \
  node test/support/scan-diff-secrets.mjs \
    public/dispatch.html \
    public/dispatch.js \
    src/dispatch-co-lifecycle.js \
    test/dispatch-co-authoritative-route-spec.md \
    test/dispatch/frontend/dispatch-completion-ui.test.js \
    test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
    test/dispatch/frontend/dispatch-po-ref-link-search.test.js \
    test/dispatch/frontend/dispatch-unplan-freshness.red.test.js \
    test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js \
    test/dispatch/property/dispatch-co-authoritative-route-merge.property.test.js \
    test/dispatch/property/dispatch-co-snapshot-route-authority.property.test.js \
    test/support/run-dispatch-co-authoritative-route-mutations.mjs \
    test/support/run-dispatch-co-snapshot-route-mutations.mjs \
    tools/dispatch-co-authoritative-route-gauntlet.sh \
    tools/dispatch-co-authoritative-route-source-state.sh
bash "${server_root}/tools/dispatch-co-authoritative-route-source-state.sh"

echo "CO authoritative-route gauntlet complete."
