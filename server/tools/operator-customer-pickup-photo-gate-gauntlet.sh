#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-operator-customer-pickup-photo-gate-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Customer Pickup photo-gate gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools --profile runtime --profile e2e down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

echo "[operator-customer-pickup-photo-gate] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools --profile runtime --profile e2e build test mutation app e2e
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[operator-customer-pickup-photo-gate] executable focused contract"
"${compose[@]}" --profile tools run --rm test npm run test:operator-customer-pickup-photo-gate

echo "[operator-customer-pickup-photo-gate] full Node regression suite"
"${compose[@]}" --profile tools run --rm test npm run test:mbt

echo "[operator-customer-pickup-photo-gate] syntax, types, lint, and coverage"
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test npm run lint:mbt
"${compose[@]}" --profile tools run --rm test npm run coverage:operator-customer-pickup-photo-gate

echo "[operator-customer-pickup-photo-gate] eight critical mutations"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:operator-customer-pickup-photo-gate

echo "[operator-customer-pickup-photo-gate] dependencies, licenses, secrets, and source state"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test npm run licenses:mbt
"${compose[@]}" --profile tools run --rm test npm run secrets:operator-customer-pickup-photo-gate
bash "${server_root}/tools/operator-customer-pickup-photo-gate-source-state.sh"

echo "[operator-customer-pickup-photo-gate] real browser execution"
"${compose[@]}" --profile runtime up -d --wait app
"${compose[@]}" --profile runtime --profile e2e run --rm e2e \
  npx playwright test --config test/playwright.config.mjs \
    test/mbt/e2e/operator-customer-pickup-photo-gate.spec.js

echo "[operator-customer-pickup-photo-gate] complete"
