#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-transfer-source-backorder-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

cleanup
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
docker update --cpus 0.5 "${test_project}-db-1" >/dev/null
"${compose[@]}" --profile tools run --rm --cpus 0.5 migrate
"${compose[@]}" --profile tools run --rm --cpus 0.5 test npm run test:transfer-dependency-source-backorder
"${compose[@]}" --profile tools run --rm --cpus 0.5 test npm run coverage:transfer-dependency-source-backorder
"${compose[@]}" --profile tools run --rm --cpus 0.5 test npm run lint:transfer-dependency-source-backorder
"${compose[@]}" --profile tools run --rm --cpus 0.5 test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm --cpus 0.5 -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:transfer-dependency-source-backorder
"${compose[@]}" --profile tools run --rm --cpus 0.5 test npm run secrets:transfer-dependency-source-backorder

echo "Transfer dependency source-backorder gauntlet complete."
