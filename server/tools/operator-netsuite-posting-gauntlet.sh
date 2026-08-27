#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-operator-netsuite-posting-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Operator NetSuite posting gauntlet could not find docker-compose.mbt-test.yml." >&2
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

echo "[operator-netsuite-posting] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools --profile runtime --profile e2e build test mutation app e2e
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[operator-netsuite-posting] focused executable contract twice"
"${compose[@]}" --profile tools run --rm test npm run test:operator-netsuite-posting-gates
"${compose[@]}" --profile tools run --rm test npm run test:operator-netsuite-posting-gates

echo "[operator-netsuite-posting] syntax, types, lint, coverage, and mutation"
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test npm run lint:operator-netsuite-posting-gates
"${compose[@]}" --profile tools run --rm test npm run coverage:operator-netsuite-posting-gates
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:operator-netsuite-posting-gates

echo "[operator-netsuite-posting] full Node and browser regressions"
"${compose[@]}" --profile tools run --rm test npm run test:mbt
"${compose[@]}" --profile runtime up -d --wait app
"${compose[@]}" --profile runtime --profile e2e run --rm e2e npm run test:mbt:e2e

echo "[operator-netsuite-posting] dependencies, licenses, secrets, and source state"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test npm run licenses:mbt
"${compose[@]}" --profile tools run --rm test npm run secrets:operator-netsuite-posting-gates
bash "${server_root}/tools/operator-netsuite-posting-source-state.sh"
git -C "${repo_root}" diff --check

echo "[operator-netsuite-posting] complete; production gates remain off pending sandbox IF/IR proof"
