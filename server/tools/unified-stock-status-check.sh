#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
mode="${1:-full}"
project="mbbs-unified-status-$$"
out="$PWD/server/test-artifacts/unified-stock-status"
mkdir -p "$out"
compose=(docker compose -p "$project" -f docker-compose.mbt-test.yml -f docker-compose.unified-stock-status-test.yml)
cleanup() {
  result=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans >"$out/cleanup-$mode.log" 2>&1 || result=1
  docker ps --format '{{.Names}} {{.Status}}' >"$out/docker-running-$mode.log"
  docker ps -a --format '{{.Names}} {{.Status}}' >"$out/docker-all-$mode.log"
  if docker ps -aq --filter "label=com.docker.compose.project=$project" | read -r _; then result=1; fi
  docker volume ls -q --filter "label=com.docker.compose.project=$project" >"$out/volumes-$mode.log"
  docker network ls -q --filter "label=com.docker.compose.project=$project" >"$out/networks-$mode.log"
  if [[ -s "$out/volumes-$mode.log" || -s "$out/networks-$mode.log" ]]; then result=1; fi
  docker inspect mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-ollama-1 --format '{{.Name}} {{.State.Health.Status}}' >"$out/production-health-$mode.log" || result=1
  if rg -v ' healthy$' "$out/production-health-$mode.log"; then result=1; fi
  docker exec mbbs-operator-app-app-1 node -e 'fetch("http://127.0.0.1:3000/health").then(r=>{console.log(r.status);if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >"$out/production-http-health-$mode.log" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 docker/verify-memory-limits.py >"$out/resource-check-$mode.log"
run() { "${compose[@]}" run --rm --no-deps -T test "$@"; }
case "$mode" in
  red|unit)
    run node --test --test-concurrency=1 test/mbt/unit/regular-stock-status.test.js test/mbt/property/regular-stock-status.property.test.js 2>&1 | tee "$out/$mode.log" ;;
  baseline)
    run node --test --test-concurrency=1 test/mbt/unit/special-supply-waiting.test.js test/mbt/unit/backorder-workflow.test.js test/mbt/unit/regular-stock-domain.test.js test/mbt/unit/regular-stock-resolution.test.js test/mbt/unit/regular-waitlist-domain.test.js 2>&1 | tee "$out/baseline.log" ;;
  checks)
    run node tools/unified-stock-status-gauntlet.mjs checks 2>&1 | tee "$out/checks.log" ;;
  *)
    "${compose[@]}" up -d --wait db
    "${compose[@]}" run --rm --no-deps -T migrate node src/migrate.js >"$out/migrations-$mode.log" 2>&1
    run node tools/unified-stock-status-gauntlet.mjs "$mode" 2>&1 | tee "$out/$mode.log" ;;
esac
