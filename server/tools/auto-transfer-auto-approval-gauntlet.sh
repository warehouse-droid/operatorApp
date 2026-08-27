#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-auto-transfer-auto-approval-test"
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
"${compose[@]}" --profile tools run --rm test npm run test:auto-transfer-auto-approval
"${compose[@]}" --profile tools run --rm test npm run test:order-dependencies
"${compose[@]}" --profile tools run --rm test npm run coverage:auto-transfer-auto-approval
"${compose[@]}" --profile tools run --rm test npm run lint:auto-transfer-auto-approval
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:auto-transfer-auto-approval
"${compose[@]}" --profile tools run --rm test npm run mutate:scm-transfer-workflow
"${compose[@]}" --profile tools run --rm test npm run secrets:auto-transfer-auto-approval

echo "Auto Transfer auto-approval gauntlet complete."
