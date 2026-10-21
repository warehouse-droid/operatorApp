#!/usr/bin/env bash
set -euo pipefail
cd /home/ubuntu/apps/operatorApp
artifact=server/test-artifacts/bin-order-workflow-20261020
phase=${1:?phase required}
mode=${2:-unit}
shift 2
compose=(docker compose -p mbbs-bin-workflow-20261020 -f docker-compose.mbt-test.yml -f docker-compose.unified-stock-status-test.yml -f "$artifact/compose.yml")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans > "$artifact/$phase-cleanup.log" 2>&1 || result=1
  docker ps --format '{{.Names}} {{.Status}}' > "$artifact/$phase-docker-ps.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$artifact/$phase-docker-ps-a.log"
  docker volume ls --filter label=com.docker.compose.project=mbbs-bin-workflow-20261020 --format '{{.Name}}' > "$artifact/$phase-volumes.log"
  docker network ls --filter label=com.docker.compose.project=mbbs-bin-workflow-20261020 --format '{{.Name}}' > "$artifact/$phase-networks.log"
  if docker ps -a --format '{{.Names}}' | rg '^mbbs-bin-workflow-20261020'; then result=1; fi
  if [ -s "$artifact/$phase-volumes.log" ] || [ -s "$artifact/$phase-networks.log" ]; then result=1; fi
  curl --fail --silent http://127.0.0.1:3000/health > "$artifact/$phase-health.json" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$artifact/browser-artifacts"
if [ "$mode" = unit ]; then
  "${compose[@]}" run --rm --no-deps -T test node --test --test-concurrency=1 "$@" > "$artifact/$phase-tests.log" 2>&1
elif [ "$mode" = static ]; then
  "${compose[@]}" run --rm --no-deps -T test "$@" > "$artifact/$phase-tests.log" 2>&1
else
  "${compose[@]}" up -d --wait db > "$artifact/$phase-db.log" 2>&1
  "${compose[@]}" run --rm -T migrate > "$artifact/$phase-migrate.log" 2>&1
  if [ "$mode" = db-command ]; then
    "${compose[@]}" run --rm -T test "$@" > "$artifact/$phase-tests.log" 2>&1
  else
    "${compose[@]}" run --rm -T test node tools/bin-planning-suites.mjs "$@" > "$artifact/$phase-tests.log" 2>&1
  fi
fi
