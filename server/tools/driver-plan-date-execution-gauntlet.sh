#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-driver-plan-date-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

cleanup
"${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate
"${compose[@]}" --profile tools run --rm test npm run test:driver-plan-date-execution
"${compose[@]}" --profile tools run --rm test npm run coverage:driver-plan-date-execution
"${compose[@]}" --profile tools run --rm test npm run lint:driver-plan-date-execution
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:driver-plan-date-execution
"${compose[@]}" --profile tools run --rm test npm run secrets:driver-plan-date-execution

echo "Driver plan-date execution gauntlet complete."
