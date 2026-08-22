#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-delayed-status-refresh-test"
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
"${compose[@]}" --profile tools run --rm --cpus 0.5 test npm run test:netsuite-delayed-status-refresh
"${compose[@]}" --profile tools run --rm --cpus 0.5 test node --test --test-concurrency=1 test/mbt/integration/migration-upgrade.test.js
"${compose[@]}" --profile tools run --rm --cpus 0.5 test npm run coverage:netsuite-delayed-status-refresh
"${compose[@]}" --profile tools run --rm --cpus 0.5 test npm run lint:netsuite-delayed-status-refresh
"${compose[@]}" --profile tools run --rm --cpus 0.5 test node --check src/server.js
"${compose[@]}" --profile tools run --rm --cpus 0.5 -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:netsuite-delayed-status-refresh
"${compose[@]}" --profile tools run --rm --cpus 0.5 test npm run secrets:netsuite-delayed-status-refresh

echo "Durable NetSuite delayed status refresh gauntlet complete."
