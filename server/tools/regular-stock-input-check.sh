#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
mode="${1:-full}"
project="mbbs-regular-input-$$"
out="${REGULAR_INPUT_OUTPUT:-$PWD/server/test-artifacts/regular-stock-input-20261020}"
mkdir -p "$out"
compose=(sudo -n docker compose -p "$project" -f docker-compose.mbt-test.yml -f docker-compose.unified-stock-status-test.yml)
if [[ -n "${REGULAR_INPUT_OVERLAY:-}" ]]; then compose+=(-f "$REGULAR_INPUT_OVERLAY"); fi
cleanup() {
  result=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans >"$out/cleanup-$mode.log" 2>&1 || result=1
  sudo -n docker ps --format '{{.Names}} {{.Status}}' >"$out/docker-running-$mode.log"
  sudo -n docker ps -a --format '{{.Names}} {{.Status}}' >"$out/docker-all-$mode.log"
  sudo -n docker volume ls -q --filter "label=com.docker.compose.project=$project" >"$out/volumes-$mode.log"
  sudo -n docker network ls -q --filter "label=com.docker.compose.project=$project" >"$out/networks-$mode.log"
  if [[ -s "$out/volumes-$mode.log" || -s "$out/networks-$mode.log" ]]; then result=1; fi
  if sudo -n docker ps -aq --filter "label=com.docker.compose.project=$project" | read -r _; then result=1; fi
  sudo -n docker inspect mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-ollama-1 --format '{{.Name}} {{.State.Health.Status}}' >"$out/production-health-$mode.log" || result=1
  if rg -v ' healthy$' "$out/production-health-$mode.log"; then result=1; fi
  sudo -n docker exec mbbs-operator-app-app-1 node -e 'fetch("http://127.0.0.1:3000/health").then(r=>{console.log(r.status);if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >"$out/production-http-health-$mode.log" || result=1
  if [[ "$result" == 0 && -n "${REGULAR_INPUT_CLEANUP_MARKER:-}" ]]; then touch "$REGULAR_INPUT_CLEANUP_MARKER"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 server/tools/regular-stock-input-coverage-lines.py "${REGULAR_INPUT_SOURCE:-$PWD/server}" "$out"
sudo -n python3 docker/verify-memory-limits.py >"$out/resource-check-$mode.log"
run() { "${compose[@]}" run --rm --no-deps -T test "$@"; }
if [[ "$mode" == checks ]]; then
  run node tools/regular-stock-input-checks.mjs 2>&1 | tee "$out/checks.log"
elif [[ "$mode" == red || "$mode" == unit ]]; then
  run node --test test/mbt/unit/regular-stock-input.test.js 2>&1 | tee "$out/$mode.log"
else
  "${compose[@]}" up -d --wait db
  "${compose[@]}" run --rm --no-deps -T migrate node src/migrate.js >"$out/migrations-$mode.log" 2>&1
  if [[ "$mode" == browsers ]]; then
    run node --test --test-concurrency=1 test/mbt/integration/regular-stock-status.test.js test/mbt/integration/regular-stock-resolution-browser.test.js 2>&1 | tee "$out/browsers.log"
    exit 0
  fi
  if [[ "$mode" == full ]]; then
    run node tools/regular-stock-input-checks.mjs 2>&1 | tee "$out/checks.log"
    run node -e 'const fs=require("fs");const p="test-artifacts/regular-stock-input-20261020/v8";fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p,{recursive:true});'
  fi
  "${compose[@]}" run --rm --no-deps -T -e NODE_V8_COVERAGE=/app/test-artifacts/regular-stock-input-20261020/v8 test node --test --test-concurrency=1 test/mbt/unit/regular-stock-input.test.js test/mbt/integration/regular-stock-input.test.js 2>&1 | tee "$out/$mode.log"
  if [[ "$mode" == full ]]; then
    "${compose[@]}" run --rm --no-deps -T -e NODE_V8_COVERAGE=/app/test-artifacts/regular-stock-input-20261020/v8 test node --test --test-concurrency=1 test/mbt/unit/regular-stock-status.test.js test/mbt/property/regular-stock-status.property.test.js test/mbt/unit/regular-stock-domain.test.js test/mbt/unit/regular-stock-controls.test.js test/mbt/unit/regular-stock-purchase-domain.test.js test/mbt/unit/sales-stock-multiselect.test.js test/mbt/integration/regular-stock-request.test.js test/mbt/integration/regular-stock-controls.test.js test/mbt/integration/regular-stock-controls-http.test.js test/mbt/integration/regular-stock-status.test.js test/mbt/integration/regular-stock-resolution-browser.test.js 2>&1 | tee "$out/regressions.log"
    run node node_modules/c8/bin/c8.js report --temp-directory test-artifacts/regular-stock-input-20261020/v8 --reports-dir test-artifacts/regular-stock-input-20261020/coverage --reporter=text --reporter=json --reporter=json-summary --include public/regular-stock-status.js --include public/regular-stock-status-ui.js --include public/regular-stock-alert.js --include src/regular-stock-expiry.js --include src/regular-stock-request-service.js --include public/sales-stock-list-filters.js --include public/sales-stock-requests.js --include public/scm-stock-requests.js --include public/regular-stock-ui.js --include public/app-sidebar.js --include src/stock-request-repository.js --include src/server.js --include src/regular-stock-domain.js 2>&1 | tee "$out/coverage.log"
    run node tools/regular-stock-input-coverage.mjs 2>&1 | tee "$out/changed-line-coverage.log"
  fi
fi
