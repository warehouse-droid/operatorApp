#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-operator-linked-fulfillment-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Operator linked-fulfillment gauntlet could not find docker-compose.mbt-test.yml." >&2
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

echo "[operator-linked-fulfillment] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools --profile runtime --profile e2e build test mutation app e2e
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[operator-linked-fulfillment] focused contract twice"
"${compose[@]}" --profile tools run --rm test npm run test:operator-linked-fulfillment
"${compose[@]}" --profile tools run --rm test npm run test:operator-linked-fulfillment

echo "[operator-linked-fulfillment] syntax, types, lint, coverage, and mutation"
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test npm run lint:operator-linked-fulfillment
"${compose[@]}" --profile tools run --rm test npm run coverage:operator-linked-fulfillment
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:operator-linked-fulfillment

echo "[operator-linked-fulfillment] ownership, dependency, full Node, and browser regressions"
"${compose[@]}" --profile tools run --rm test npm run test:operator-netsuite-posting-gates
"${compose[@]}" --profile tools run --rm test npm run test:order-dependencies
"${compose[@]}" --profile tools run --rm test npm run test:mbt
"${compose[@]}" --profile runtime up -d --wait app
"${compose[@]}" --profile runtime --profile e2e run --rm e2e npm run test:mbt:e2e

echo "[operator-linked-fulfillment] dependencies, licenses, secrets, and source state"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test npm run licenses:mbt
"${compose[@]}" --profile tools run --rm test npm run secrets:operator-linked-fulfillment
bash "${server_root}/tools/operator-linked-fulfillment-source-state.sh"
git -C "${repo_root}" diff --check

echo "[operator-linked-fulfillment] complete; all four automatic SO IF gates remain default-off"
