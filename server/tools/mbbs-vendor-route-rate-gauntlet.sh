#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-vendor-route-rate-test"
coverage_dir="${server_root}/test-artifacts/mbbs-vendor-route-rate-coverage"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "MBBS vendor-route gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi
if [[ "${coverage_dir}" != "${server_root}/test-artifacts/mbbs-vendor-route-rate-coverage" ]]; then
  echo "Refusing to clear an unexpected coverage path." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools --profile runtime --profile e2e down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

rm -rf -- "${coverage_dir}"

echo "[mbbs-vendor-route] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools --profile runtime --profile e2e build test mutation app e2e
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[mbbs-vendor-route] focused executable specification"
"${compose[@]}" --profile tools run --rm test npm run test:mbt:mbbs-vendor-route-rates

echo "[mbbs-vendor-route] complete Node regression suite"
"${compose[@]}" --profile tools run --rm test npm run test:mbt

echo "[mbbs-vendor-route] syntax, types, lint, and changed-module coverage"
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test npm run lint:mbt
"${compose[@]}" --profile tools run --rm test npm run coverage:mbt:mbbs-vendor-route-rates

echo "[mbbs-vendor-route] thirteen critical mutations"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:mbt:mbbs-vendor-route-rates

echo "[mbbs-vendor-route] deterministic shuffled suite"
"${compose[@]}" --profile tools run --rm \
  -e MBT_SHUFFLE_SEED=2026081601 \
  test npm run test:mbt:shuffled

echo "[mbbs-vendor-route] dependencies, licenses, secrets, and source state"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test npm run licenses:mbt
"${compose[@]}" --profile tools run --rm test npm run secrets:mbt:mbbs-vendor-route-rates
bash "${server_root}/tools/mbbs-vendor-route-rate-source-state.sh"

echo "[mbbs-vendor-route] real Admin and Billing browser execution"
"${compose[@]}" --profile runtime up -d --wait app
"${compose[@]}" --profile runtime --profile e2e run --rm e2e \
  npx playwright test --config test/playwright.config.mjs \
    test/mbt/e2e/p3-config-friendly-editor.spec.js \
    test/mbt/e2e/p3-billing.spec.js

echo "[mbbs-vendor-route] complete"
