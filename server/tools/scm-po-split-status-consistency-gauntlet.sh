#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-scm-po-split-status-test"
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
"${compose[@]}" --profile tools run --rm test npm run test:scm-po-split-status-consistency
"${compose[@]}" --profile tools run --rm test node --test --test-concurrency=1 test/workload/integration/scm-po-catalog.red.test.js
"${compose[@]}" --profile tools run --rm test npm run test:scm-authoritative-schedule-status
"${compose[@]}" --profile tools run --rm test npm run test:scm-order-visibility-integration
"${compose[@]}" --profile tools run --rm test npm run test:scm-po-split-filters
"${compose[@]}" --profile tools run --rm test npm run test:scm-po-split-ui
"${compose[@]}" --profile tools run --rm test npm run test:scm-schedule-loading
"${compose[@]}" --profile tools run --rm test npm run coverage:scm-po-split-status-consistency
"${compose[@]}" --profile tools run --rm test npm run lint:scm-po-split-status-consistency
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:scm-po-split-status-consistency
"${compose[@]}" --profile tools run --rm test npm run secrets:scm-po-split-status-consistency
"${compose[@]}" --profile tools run --rm test bash tools/scm-po-split-status-consistency-source-state.sh

echo "PO Split discovery and status-consistency gauntlet complete."
