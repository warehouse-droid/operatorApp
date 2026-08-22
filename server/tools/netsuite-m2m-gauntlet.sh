#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-netsuite-m2m-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "NetSuite M2M gauntlet could not find docker-compose.mbt-test.yml." >&2
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

echo "[netsuite-m2m] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools --profile runtime --profile e2e build test mutation app e2e
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[netsuite-m2m] focused authentication, security, HTTP, and reconciliation contracts"
"${compose[@]}" --profile tools run --rm test npm run test:netsuite-m2m

echo "[netsuite-m2m] complete Node regression suite"
"${compose[@]}" --profile tools run --rm test npm run test:mbt

echo "[netsuite-m2m] syntax, types, focused lint, and coverage"
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test npm run lint:netsuite-m2m
"${compose[@]}" --profile tools run --rm test npm run coverage:netsuite-m2m

echo "[netsuite-m2m] eight critical mutations"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:netsuite-m2m

echo "[netsuite-m2m] dependencies, licenses, secrets, and source state"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test npm run licenses:mbt
"${compose[@]}" --profile tools run --rm test npm run secrets:netsuite-m2m
bash "${server_root}/tools/netsuite-m2m-source-state.sh"

echo "[netsuite-m2m] real browser execution"
"${compose[@]}" --profile runtime up -d --wait app
"${compose[@]}" --profile runtime --profile e2e run --rm e2e \
  npx playwright test --config test/playwright.config.mjs \
    test/mbt/e2e/netsuite-m2m-admin.spec.js

echo "[netsuite-m2m] complete"
