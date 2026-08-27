#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-dispatch-po-route-residual-test"
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
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-po-route-residual
"${compose[@]}" --profile tools run --rm test npm run test:scm-dependency-management
"${compose[@]}" --profile tools run --rm test npm run coverage:dispatch-po-route-residual
"${compose[@]}" --profile tools run --rm test npm run lint:dispatch-po-route-residual
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:dispatch-po-route-residual
"${compose[@]}" --profile tools run --rm test npm run secrets:dispatch-po-route-residual
"${compose[@]}" --profile tools run --rm test bash tools/dispatch-po-route-residual-source-state.sh

echo "Dispatch PO direct-ship residual gauntlet complete."
