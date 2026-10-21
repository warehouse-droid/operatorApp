#!/usr/bin/env bash
set -Eeuo pipefail
cd /home/ubuntu/apps/operatorApp
mode=${1:-red}
evidence="$PWD/server/artifacts/pob04042-ir-20261019"
compose=(docker compose -p mbbs-pob04042-ir-test -f docker-compose.mbt-test.yml -f server/tools/pob04042-ir/compose.yml)
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans > "$evidence/${mode}-teardown.log" 2>&1
  docker ps --format '{{.Names}} {{.Status}}' > "$evidence/${mode}-integration-running.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$evidence/${mode}-integration-all.txt"
}
trap cleanup EXIT INT TERM
"${compose[@]}" up -d --wait db > "$evidence/${mode}-db.log" 2>&1
"${compose[@]}" run --rm --no-deps -T migrate > "$evidence/${mode}-migrate.log" 2>&1
"${compose[@]}" run --rm --no-deps -T test > "$evidence/${mode}-integration.log" 2>&1
tail -18 "$evidence/${mode}-integration.log"
