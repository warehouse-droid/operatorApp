#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$task_root/../../.." && pwd)"
out="$repo_root/server/test-artifacts/sor-return-unblocked-20261016"
mode="${1:?Use red or green}"
[[ "$mode" == red || "$mode" == green ]]
project=mbbs-sor-return-unblocked-20261016
compose=(docker compose -p "$project" -f "$repo_root/docker-compose.mbt-test.yml" -f "$task_root/compose.test.yml")
if [[ "$mode" == green ]]; then compose+=(-f "$task_root/compose.green.yml"); fi
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans > "$out/$mode-cleanup.log" 2>&1 || result=1
  docker ps --format '{{.Names}} {{.Status}}' > "$out/$mode-docker-ps.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$out/$mode-docker-ps-a.txt"
  if docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' | rg .; then result=1; fi
  if docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' | rg .; then result=1; fi
  if docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' | rg .; then result=1; fi
  curl --fail --silent http://127.0.0.1:3000/health > "$out/$mode-health.json" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${compose[@]}" up -d --wait --pull never db > "$out/$mode-db.log" 2>&1
"${compose[@]}" run --rm --no-deps migrate > "$out/$mode-migrations.log" 2>&1
set +e
if [[ "$mode" == red ]]; then
  "${compose[@]}" run --rm --no-deps test node --test --test-concurrency=1 test/dispatch/integration/sor-return-driver-readiness.test.js > "$out/red-tests.log" 2>&1
else
  "${compose[@]}" run --rm --no-deps test node --test --test-concurrency=1 \
    test/dispatch/integration/sor-return-driver-readiness.test.js \
    test/dispatch/integration/sor-return-lifecycle.test.js \
    test/dispatch/integration/dispatch-sor-return-date-conflict.test.js \
    test/dispatch/integration/sor-rental-repository.test.js > "$out/green-tests.log" 2>&1
fi
status=$?
set -e
tail -n 16 "$out/$mode-tests.log"
if [[ "$mode" == red ]]; then
  [[ "$status" != 0 ]]
  rg -q 'waiting for delivery|false !== true' "$out/red-tests.log"
else
  [[ "$status" == 0 ]]
fi
