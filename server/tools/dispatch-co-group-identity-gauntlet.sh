#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-dispatch-co-group-identity-gauntlet"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Dispatch CO group identity gauntlet could not find docker-compose.mbt-test.yml." >&2
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
  cleanup
  "${compose[@]}" up -d --wait db
  "${compose[@]}" --profile tools run --rm migrate
}
trap cleanup EXIT
cd "${repo_root}"

echo "[dispatch-co-group] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools build test mutation
reset_database

echo "[dispatch-co-group] executable specification"
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-co-group-identity
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 \
    test/mbt/infrastructure/p3-gauntlet-contract.test.js

echo "[dispatch-co-group] syntax, lint, and types"
"${compose[@]}" --profile tools run --rm test node --check src/dispatch-co-group-identity.js
"${compose[@]}" --profile tools run --rm test node --check src/dispatch-co-group-identity-repository.js
"${compose[@]}" --profile tools run --rm test node --check public/dispatch.js
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    public/dispatch.js \
    src/dispatch-co-group-identity.js \
    src/dispatch-co-group-identity-repository.js \
    src/dispatch-co-lifecycle.js \
    src/dispatch-custom-order-repository.js \
    src/dispatch-plan-repository.js \
    src/dispatch-planner-performance.js \
    src/dispatch-planner-v2-repository.js \
    src/dispatch-repository.js \
    src/mirror-dispatch-plan.js \
    src/server.js \
    test/dispatch/frontend/dispatch-runtime-resilience.red.test.js \
    test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js \
    test/dispatch/integration/dispatch-co-group-identity-repair.red.test.js \
    test/dispatch/property/dispatch-co-group-identity.property.test.js \
    test/dispatch/unit/dispatch-co-group-identity.red.test.js \
    test/support/run-dispatch-co-group-identity-mutations.mjs
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt

echo "[dispatch-co-group] coverage and mutation"
reset_database
"${compose[@]}" --profile tools run --rm test npm run coverage:dispatch-co-group-identity
reset_database
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:dispatch-co-group-identity

echo "[dispatch-co-group] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    package.json \
    public/dispatch.js \
    src/dispatch-co-group-identity.js \
    src/dispatch-co-group-identity-repository.js \
    src/dispatch-co-lifecycle.js \
    src/dispatch-custom-order-repository.js \
    src/dispatch-plan-repository.js \
    src/dispatch-planner-performance.js \
    src/dispatch-planner-v2-repository.js \
    src/dispatch-repository.js \
    src/mirror-dispatch-plan.js \
    src/server.js \
    test/dispatch-co-group-identity-evidence.md \
    test/dispatch-co-group-identity-spec.md \
    test/dispatch/frontend/dispatch-runtime-resilience.red.test.js \
    test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js \
    test/dispatch/integration/dispatch-co-group-identity-repair.red.test.js \
    test/dispatch/property/dispatch-co-group-identity.property.test.js \
    test/dispatch/unit/dispatch-co-group-identity.red.test.js \
    test/support/p3-mutation-manifest.mjs \
    test/support/run-dispatch-co-group-identity-mutations.mjs \
    tools/dispatch-co-group-identity-gauntlet.sh \
    tools/dispatch-co-group-identity-source-state.sh
bash "${server_root}/tools/dispatch-co-group-identity-source-state.sh"
echo "[dispatch-co-group] complete"
