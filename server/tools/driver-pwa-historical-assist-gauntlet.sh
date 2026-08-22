#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-driver-historical-assist-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Historical completion gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools --profile runtime --profile e2e down --rmi local --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

cleanup
echo "[historical-assist] fresh isolated images and database"
"${compose[@]}" --profile tools --profile runtime --profile e2e build test mutation app e2e
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[historical-assist] executable specification and database integration"
"${compose[@]}" --profile tools run --rm test npm run test:driver-pwa-historical-assist

echo "[historical-assist] syntax, types, lint, and changed-module coverage"
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test npm run lint:driver-pwa-historical-assist
"${compose[@]}" --profile tools run --rm test npm run coverage:driver-pwa-historical-assist

echo "[historical-assist] eight critical mutations"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:driver-pwa-historical-assist

echo "[historical-assist] complete Node regression and deterministic shuffle"
"${compose[@]}" --profile tools run --rm test npm run test:mbt
"${compose[@]}" --profile tools run --rm \
  -e MBT_SHUFFLE_SEED=2026082001 \
  test npm run test:mbt:shuffled

echo "[historical-assist] dependencies, licenses, secrets, and source state"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test npm run licenses:mbt
"${compose[@]}" --profile tools run --rm test npm run secrets:driver-pwa-historical-assist
bash "${server_root}/tools/driver-pwa-historical-assist-source-state.sh"

echo "[historical-assist] browser UI and unchanged 320-case Driver offline campaign"
"${compose[@]}" --profile runtime up -d --wait app
"${compose[@]}" --profile runtime --profile e2e run --rm e2e \
  npx playwright test --config test/playwright.config.mjs \
  test/mbt/e2e/driver-pwa-historical-assist.spec.js
"${compose[@]}" --profile runtime --profile e2e run --rm e2e npm run test:driver-offline-stress:full

echo "[historical-assist] complete; isolated containers, volumes, and local images will now be removed"
