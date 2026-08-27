#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-scm-split-receipt-test"
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
"${compose[@]}" --profile tools run --rm test npm run test:scm-split-receipt-allocation
"${compose[@]}" --profile tools run --rm test npm run test:scm-reconciliation-repository
"${compose[@]}" --profile tools run --rm test npm run test:scm-reconciliation
"${compose[@]}" --profile tools run --rm test npm run test:grouped-po-reconciliation-integration
"${compose[@]}" --profile tools run --rm test npm run test:scm-po-split-ui
"${compose[@]}" --profile tools run --rm test npm run test:scm-authoritative-schedule-status
"${compose[@]}" --profile tools run --rm test npm run coverage:scm-split-receipt-allocation
"${compose[@]}" --profile tools run --rm test npm run lint:scm-split-receipt-allocation
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:scm-split-receipt-allocation
"${compose[@]}" --profile tools run --rm test npm run secrets:scm-split-receipt-allocation
"${compose[@]}" --profile tools run --rm test bash tools/scm-split-receipt-allocation-source-state.sh

echo "SCM split receipt allocation gauntlet complete."
