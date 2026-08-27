#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-scm-authoritative-status-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

cleanup
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate
"${compose[@]}" --profile tools run --rm test npm run test:scm-authoritative-schedule-status
"${compose[@]}" --profile tools run --rm test npm run test:scm-reconciliation
"${compose[@]}" --profile tools run --rm test npm run test:scm-vrma
"${compose[@]}" --profile tools run --rm test node --test --test-concurrency=1 test/mbt/integration/migration-upgrade.test.js
"${compose[@]}" --profile tools run --rm test npm run coverage:scm-authoritative-schedule-status
"${compose[@]}" --profile tools run --rm test npm run lint:scm-authoritative-schedule-status
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:scm-authoritative-schedule-status
"${compose[@]}" --profile tools run --rm test npm run secrets:scm-authoritative-schedule-status
"${compose[@]}" --profile tools run --rm test bash tools/scm-authoritative-schedule-status-source-state.sh

echo "SCM authoritative schedule status gauntlet complete."
