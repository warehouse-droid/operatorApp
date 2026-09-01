#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-smart-scm-blanket-residual-test"
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
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-blanket-residual-coverage
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-phased-po-split
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-manual-controls
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-blanket-merge
"${compose[@]}" --profile tools run --rm test npm run coverage:smart-scm-blanket-residual-coverage
"${compose[@]}" --profile tools run --rm test npm run lint:smart-scm-blanket-residual-coverage
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:smart-scm-blanket-residual-coverage
"${compose[@]}" --profile tools run --rm test npm run secrets:smart-scm-blanket-residual-coverage
bash "${server_root}/tools/smart-scm-blanket-residual-coverage-source-state.sh"

echo "Smart SCM Blanket residual-coverage gauntlet complete."
