#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-cross-charge-v4-gauntlet"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "MBBS cross-charge v4 gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

echo "[mbbs-cross-charge-v4] fresh isolated image and database"
cleanup
"${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[mbbs-cross-charge-v4] executable specification and regressions"
"${compose[@]}" --profile tools run --rm test npm run test:mbt:mbbs-cross-charge-v4

echo "[mbbs-cross-charge-v4] syntax, types, lint, and changed-core coverage"
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test npx eslint --config eslint.mbt.config.js --max-warnings=0 \
  src/mbt public/mbt-billing.js public/mbt-shell.js \
  test/mbt/unit/mbbs-cross-charge-route-pricing-v4.red.test.js \
  test/mbt/property/mbbs-cross-charge-route-pricing-v4.property.test.js \
  test/mbt/integration/mbbs-cross-charge-route-pricing-v4-migration.test.js \
  test/support/run-mbbs-cross-charge-v4-mutations.mjs
"${compose[@]}" --profile tools run --rm test npm run coverage:mbt:mbbs-cross-charge-v4

echo "[mbbs-cross-charge-v4] critical mutation score"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:mbt:mbbs-cross-charge-v4

echo "[mbbs-cross-charge-v4] production-shaped migration cutover"
cleanup
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate
"${compose[@]}" --profile tools run --rm \
  -e MBT_CROSS_CHARGE_MIGRATION_CUTOVER_TEST=1 \
  test node --test --test-concurrency=1 \
  test/mbt/integration/mbbs-cross-charge-route-pricing-v4-migration.test.js

echo "[mbbs-cross-charge-v4] secrets and source state"
"${compose[@]}" --profile tools run --rm test npm run secrets:mbt:mbbs-cross-charge-v4
bash "${server_root}/tools/mbbs-cross-charge-v4-source-state.sh"

echo "[mbbs-cross-charge-v4] complete"
