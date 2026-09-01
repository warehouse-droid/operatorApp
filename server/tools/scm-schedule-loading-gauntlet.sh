#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-scm-schedule-loading-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
}
fresh_database() {
  cleanup
  "${compose[@]}" up -d --wait db
  "${compose[@]}" --profile tools run --rm migrate
}
trap cleanup EXIT
cd "${repo_root}"

cleanup
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile tools build test mutation
fresh_database

echo "[scm-schedule-loading] executable specification and coverage probes"
"${compose[@]}" --profile tools run --rm test npm run test:scm-schedule-loading
"${compose[@]}" --profile tools run --rm test npm run coverage:scm-schedule-loading

echo "[scm-schedule-loading] schedule, split, assignment, and completion compatibility"
"${compose[@]}" --profile tools run --rm test npm run test:scm-authoritative-schedule-status

fresh_database
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-phased-po-split
"${compose[@]}" --profile tools run --rm test npm run test:scm-split-receipt-allocation
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-po-route-residual
"${compose[@]}" --profile tools run --rm test npm run test:dispatch:planner-optimization
"${compose[@]}" --profile tools run --rm test npm run test:scm-schedule-column-filters
"${compose[@]}" --profile tools run --rm test npm run test:scm-schedule-column-filter-integration
"${compose[@]}" --profile tools run --rm test node src/netsuite-closed-order-repository-harness.js

echo "[scm-schedule-loading] full Node regression suite and migration upgrade"
fresh_database
"${compose[@]}" --profile tools run --rm test npm run test:mbt
"${compose[@]}" --profile tools run --rm test node --test --test-concurrency=1 test/mbt/integration/migration-upgrade.test.js

echo "[scm-schedule-loading] static, mutation, supply-chain, and performance gates"
"${compose[@]}" --profile tools run --rm test npm run lint:scm-schedule-loading
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
fresh_database
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:scm-schedule-loading
"${compose[@]}" --profile tools run --rm test npm run benchmark:scm-schedule-loading
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test npm run licenses:mbt
"${compose[@]}" --profile tools run --rm test npm run secrets:scm-schedule-loading
"${compose[@]}" --profile tools run --rm test bash tools/scm-schedule-loading-source-state.sh

echo "SCM schedule loading gauntlet complete."
