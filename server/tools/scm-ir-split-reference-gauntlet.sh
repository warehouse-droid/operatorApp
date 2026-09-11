#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-scm-ir-split-reference-test"
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
"${compose[@]}" --profile tools run --rm test npm run test:scm-ir-split-reference
"${compose[@]}" --profile tools run --rm test npm run test:scm-split-receipt-allocation
"${compose[@]}" --profile tools run --rm test npm run test:scm-reconciliation-linked-fetch
"${compose[@]}" --profile tools run --rm test npm run test:scm-reconciliation-repository
"${compose[@]}" --profile tools run --rm test npm run coverage:scm-ir-split-reference
"${compose[@]}" --profile tools run --rm test npm run lint:scm-ir-split-reference
"${compose[@]}" --profile tools run --rm test npm run typecheck:scm-ir-split-reference
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:scm-ir-split-reference
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 -e MBT_MUTATION_PROPERTY_ONLY=1 mutation npm run mutate:scm-ir-split-reference
"${compose[@]}" --profile tools run --rm test npm run secrets:scm-ir-split-reference
"${compose[@]}" --profile tools run --rm test bash tools/scm-ir-split-reference-source-state.sh

echo "SCM IR split-reference reconciliation gauntlet complete."
