#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
project="mbbs-customer-webhook-test-$$"
artifact_dir="${repo_root}/server/test-artifacts/customer-webhook"
mkdir -p "${artifact_dir}"
cd "${repo_root}"
compose=(docker compose --project-name "${project}" --file docker-compose.mbt-test.yml --file server/tools/customer-webhook.compose.yml --profile tools)
cleanup() {
  local code=$?
  trap - EXIT
  "${compose[@]}" logs --no-color > "${artifact_dir}/${project}-containers.log" 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans >> "${artifact_dir}/${project}-cleanup.log" 2>&1 || code=1
  docker ps --format '{{.Names}} {{.Status}}' > "${artifact_dir}/${project}-running.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "${artifact_dir}/${project}-all.txt"
  if docker ps -a --format '{{.Names}}' | rg -q "^${project}-"; then code=1; fi
  if docker network ls --filter "label=com.docker.compose.project=${project}" --quiet | rg -q .; then code=1; fi
  if docker volume ls --filter "label=com.docker.compose.project=${project}" --quiet | rg -q .; then code=1; fi
  curl --fail --silent --show-error http://127.0.0.1:3000/health > "${artifact_dir}/${project}-production-health.json" || code=1
  exit "${code}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
test "$(systemctl show mbbs-tests.slice -p ActiveState --value)" = active
test "$(systemctl show mbbs-tests.slice -p MemoryMax --value)" = 4294967296
"${compose[@]}" up --detach --wait db
"${compose[@]}" run --rm --no-deps test node src/migrate.js > "${artifact_dir}/${project}-migrations.log" 2>&1
"${compose[@]}" run --rm --no-deps test "$@"
