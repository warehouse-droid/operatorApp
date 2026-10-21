#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
out="$root/server/test-artifacts/sales-order-null-packs-20261016"
mkdir -p "$out"
compose=(docker compose -p mbbs-so-null-packs-20261016 -f docker-compose.mbt-test.yml -f server/tools/sales-order-null-packs-20261016/compose.yml)
cleanup() {
  local status=$?
  trap - EXIT
  "${compose[@]}" down --volumes --remove-orphans >"$out/teardown.log" 2>&1 || status=1
  docker ps --format '{{.Names}} {{.Status}}' >"$out/docker-ps.log" || status=1
  docker ps -a --format '{{.Names}} {{.Status}}' >"$out/docker-ps-a.log" || status=1
  docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' \
    mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 >"$out/production-health.log" || status=1
  if grep -Ev '^mbbs-operator-app-(app|db|webhook-worker|ollama)-1 ' "$out/docker-ps-a.log" >"$out/unexpected-containers.log"; then status=1; fi
  if grep -E '(unhealthy|exited|restarting)' "$out/production-health.log"; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "${1:-}" == '--database' ]]; then
  shift
  "${compose[@]}" up -d --wait db
  "${compose[@]}" run --rm migrate node src/migrate.js
fi
"${compose[@]}" run --rm --no-deps test "$@"
