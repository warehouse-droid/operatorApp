#!/usr/bin/env bash
set -euo pipefail
stock_check_root=$(cd "$(dirname "$0")/../.." && pwd)
stock_check_stage=${1:-all}
stock_check_project=${STOCK_CHECK_TEST_PROJECT:-mbbs-stock-check-20261014-$stock_check_stage}
stock_check_artifacts=${STOCK_CHECK_TEST_ARTIFACTS:-"$stock_check_root/server/test-artifacts/stock-check"}
mkdir -p "$stock_check_artifacts"
stock_check_source=${STOCK_CHECK_SOURCE_ROOT:-./server}
stock_check_compose=(sudo -n env "STOCK_CHECK_SOURCE_ROOT=$stock_check_source" "STOCK_CHECK_TEST_IMAGE=${STOCK_CHECK_TEST_IMAGE:-mbbs-operator-app:mbr-nullable-browser-test-20261013}" "STOCK_CHECK_RUNTIME_IMAGE=${STOCK_CHECK_RUNTIME_IMAGE:-mbbs-operator-app:stock-check-20261014}" docker compose --project-directory "$stock_check_root" -p "$stock_check_project" -f "$stock_check_root/docker-compose.mbt-test.yml" -f "$stock_check_root/docker-compose.stock-check-test.yml" --profile tools --profile runtime)
stock_check_cleanup() {
  stock_check_result=$?
  trap - EXIT INT TERM
  set +e
  "${stock_check_compose[@]}" logs --no-color > "$stock_check_artifacts/$stock_check_stage-stack.log" 2>&1
  "${stock_check_compose[@]}" down --volumes --remove-orphans --timeout 10 > "$stock_check_artifacts/$stock_check_stage-cleanup.log" 2>&1
  stock_check_teardown_status=$?
  sudo -n docker ps --format '{{.Names}}\t{{.Status}}' > "$stock_check_artifacts/$stock_check_stage-docker-ps.txt"
  sudo -n docker ps -a --format '{{.Names}}\t{{.Status}}' > "$stock_check_artifacts/$stock_check_stage-docker-ps-a.txt"
  stock_check_leftovers=$(sudo -n docker ps -aq --filter "label=com.docker.compose.project=$stock_check_project")
  stock_check_health=$(sudo -n docker inspect --format '{{.State.Health.Status}}' mbbs-operator-app-app-1)
  if [[ "$stock_check_teardown_status" != 0 || -n "$stock_check_leftovers" || "$stock_check_health" != healthy ]]; then
    printf '%s\n' 'Stock Check teardown or production health verification failed.' >&2
    stock_check_result=1
  fi
  exit "$stock_check_result"
}
trap stock_check_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sudo -n systemctl is-active --quiet mbbs-tests.slice
"${stock_check_compose[@]}" config --format json | python3 -c 'import json,pathlib,sys; c=json.load(sys.stdin); actual=next(v["source"] for v in c["services"]["test"]["volumes"] if v["target"]=="/app/src");expected=str((pathlib.Path(sys.argv[1])/sys.argv[2]/"src").resolve());assert actual==expected,(actual,expected);pathlib.Path(sys.argv[3]).write_text(json.dumps({"sourceRoot":str(pathlib.Path(expected).parent),"srcMount":actual})+"\n")' "$stock_check_root" "$stock_check_source" "$stock_check_artifacts/$stock_check_stage-source.json"
if [[ "$stock_check_stage" == boot* ]]; then
  "${stock_check_compose[@]}" up -d --no-build db
  "${stock_check_compose[@]}" run --rm test node src/migrate.js > "$stock_check_artifacts/$stock_check_stage-migrate.log" 2>&1
  "${stock_check_compose[@]}" --profile runtime up -d --no-build --no-deps --wait --wait-timeout 60 app 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == final* ]]; then
  "${stock_check_compose[@]}" up -d --no-build db
  "${stock_check_compose[@]}" run --rm test node src/migrate.js > "$stock_check_artifacts/$stock_check_stage-migrate.log" 2>&1
  stock_check_files=(test/mbt/unit/stock-check-domain.test.js test/mbt/unit/stock-check-vault.test.js test/mbt/unit/stock-check-unilock-dom.test.js test/mbt/unit/stock-check-catalog.test.js test/mbt/unit/stock-check-router.test.js test/mbt/unit/stock-check-stock.test.js test/mbt/unit/stock-check-ollama.test.js test/mbt/unit/stock-check-description.test.js test/mbt/property/stock-check.property.test.js test/mbt/property/stock-check-lines.property.test.js test/mbt/property/stock-check-ollama.property.test.js test/mbt/integration/stock-check-repository.test.js test/mbt/integration/stock-check-runtime.test.js test/mbt/integration/stock-check-browser.test.js test/mbt/integration/stock-check-migration.test.js test/mbt/integration/stock-check-lines.test.js test/mbt/integration/stock-check-ollama.test.js test/mbt/integration/stock-check-lines-browser.test.js)
  if [[ "$stock_check_stage" == *shuffled ]]; then
    mapfile -t stock_check_files < <(python3 -c 'import random,sys; files=sys.argv[1:]; random.Random(20261014).shuffle(files); print("\n".join(files))' "${stock_check_files[@]}")
  fi
  printf '%s\n' "${stock_check_files[@]}" > "$stock_check_artifacts/$stock_check_stage-order.txt"
  "${stock_check_compose[@]}" run --rm test node node_modules/c8/bin/c8.js --all --src src/stock-check --include 'src/stock-check/**' --temp-directory=/tmp/stock-check-c8 --reports-dir=test-artifacts/stock-check/coverage --reporter=text --reporter=json-summary --reporter=json node tools/stock-check-suite.mjs "${stock_check_files[@]}" 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
  "${stock_check_compose[@]}" run --rm --no-deps test node tools/stock-check-lines-coverage.mjs 2>&1 | tee "$stock_check_artifacts/browser-coverage.log"
elif [[ "$stock_check_stage" == refresh* ]]; then
  "${stock_check_compose[@]}" up -d --no-build db
  "${stock_check_compose[@]}" run --rm test node src/migrate.js > "$stock_check_artifacts/$stock_check_stage-migrate.log" 2>&1
  "${stock_check_compose[@]}" run --rm test node tools/stock-check-refresh-diagnosis.mjs 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == lines* ]]; then
  "${stock_check_compose[@]}" up -d --no-build db
  "${stock_check_compose[@]}" run --rm test node src/migrate.js > "$stock_check_artifacts/$stock_check_stage-migrate.log" 2>&1
  "${stock_check_compose[@]}" run --rm test node --test --test-concurrency=1 test/mbt/integration/stock-check-lines.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == browser* ]]; then
  "${stock_check_compose[@]}" up -d --no-build db
  "${stock_check_compose[@]}" run --rm test node src/migrate.js > "$stock_check_artifacts/$stock_check_stage-migrate.log" 2>&1
  stock_check_browser_args=()
  if [[ "$stock_check_stage" == browser-mutant ]]; then stock_check_browser_args=(-v "$stock_check_root/server/test/support/stock-check-ui-mutant.js:/app/public/scm-stock-check.js:ro"); fi
  if [[ "$stock_check_stage" == browser-availability-mutant ]]; then stock_check_browser_args=(-v "$stock_check_root/server/test/support/stock-check-availability-ui-mutant.js:/app/public/scm-stock-check.js:ro"); fi
  "${stock_check_compose[@]}" run --rm "${stock_check_browser_args[@]}" -e "DEBUG=${STOCK_CHECK_BROWSER_DEBUG:-}" test node --test --test-concurrency=1 ${STOCK_CHECK_BROWSER_FILES:-test/mbt/integration/stock-check-browser.test.js test/mbt/integration/stock-check-lines-browser.test.js} 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == batch-mutations* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node tools/stock-check-batch-mutations.mjs 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == description-unit* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node --test test/mbt/unit/stock-check-description.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
  if [[ "$stock_check_stage" == *final ]]; then
    "${stock_check_compose[@]}" run --rm --no-deps test node tools/stock-check-description-mutations.mjs 2>&1 | tee "$stock_check_artifacts/$stock_check_stage-mutations.log"
  fi
elif [[ "$stock_check_stage" == ollama-unit* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node --test test/mbt/unit/stock-check-ollama.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == ollama-api* ]]; then
  "${stock_check_compose[@]}" up -d --no-build db
  "${stock_check_compose[@]}" run --rm test node src/migrate.js > "$stock_check_artifacts/$stock_check_stage-migrate.log" 2>&1
  "${stock_check_compose[@]}" run --rm test node --test --test-concurrency=1 test/mbt/integration/stock-check-ollama.test.js test/mbt/unit/stock-check-router.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == ollama-properties* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node --test test/mbt/property/stock-check-ollama.property.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
  "${stock_check_compose[@]}" run --rm --no-deps test node tools/stock-check-ollama-mutations.mjs 2>&1 | tee "$stock_check_artifacts/$stock_check_stage-mutations.log"
elif [[ "$stock_check_stage" == matching* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node --test test/mbt/property/stock-check-lines.property.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
  "${stock_check_compose[@]}" run --rm --no-deps test node tools/stock-check-lines-mutations.mjs 2>&1 | tee "$stock_check_artifacts/$stock_check_stage-mutations.log"
elif [[ "$stock_check_stage" == property* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node --test test/mbt/property/stock-check.property.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
  "${stock_check_compose[@]}" run --rm --no-deps test node tools/stock-check-mutations.mjs 2>&1 | tee "$stock_check_artifacts/$stock_check_stage-mutations.log"
elif [[ "$stock_check_stage" == runtime* ]]; then
  "${stock_check_compose[@]}" up -d --no-build db
  "${stock_check_compose[@]}" run --rm test node src/migrate.js > "$stock_check_artifacts/$stock_check_stage-migrate.log" 2>&1
  if [[ "$stock_check_stage" == runtime-mutant ]]; then
    "${stock_check_compose[@]}" run --rm test node tools/stock-check-runtime-mutations.mjs 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
  else
    "${stock_check_compose[@]}" run --rm test node --test --test-concurrency=1 test/mbt/integration/stock-check-runtime.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
  fi
elif [[ "$stock_check_stage" == full* ]]; then
  "${stock_check_compose[@]}" up -d --no-build db
  "${stock_check_compose[@]}" run --rm test node src/migrate.js > "$stock_check_artifacts/$stock_check_stage-migrate.log" 2>&1
  stock_check_regression_args=()
  if [[ -n "${STOCK_CHECK_REGRESSION_FILE:-}" ]]; then stock_check_regression_args=("$STOCK_CHECK_REGRESSION_FILE"); fi
  "${stock_check_compose[@]}" run --rm test node tools/stock-check-regressions.mjs "${stock_check_regression_args[@]}" > "$stock_check_artifacts/$stock_check_stage.log" 2>&1
elif [[ "$stock_check_stage" == static* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node node_modules/eslint/bin/eslint.js --config eslint.stock-check.config.js src/stock-check public/scm-stock-check*.js test/mbt/unit/stock-check* test/mbt/property/stock-check* test/mbt/integration/stock-check* tools/stock-check*.mjs 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
  "${stock_check_compose[@]}" run --rm --no-deps test node node_modules/typescript/lib/tsc.js --project tsconfig.stock-check.json 2>&1 | tee "$stock_check_artifacts/$stock_check_stage-types.log"
  "${stock_check_compose[@]}" run --rm --no-deps test node test/support/scan-diff-secrets.mjs src/stock-check public/scm-stock-check*.js public/scm-stock-check*.html public/scm-stock-check*.css public/scm-stock-requests.html public/scm-stock-requests.js public/scm-special-stock-requests.js public/backorder-stock-requests.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage-secrets.log"
elif [[ "$stock_check_stage" == router* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node --test --test-concurrency=1 test/mbt/unit/stock-check-router.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == stock* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node --test --test-concurrency=1 test/mbt/unit/stock-check-stock.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == repo* ]]; then
  "${stock_check_compose[@]}" up -d --no-build db
  "${stock_check_compose[@]}" run --rm test node src/migrate.js > "$stock_check_artifacts/$stock_check_stage-migrate.log" 2>&1
  "${stock_check_compose[@]}" run --rm test node --test --test-concurrency=1 test/mbt/integration/stock-check-repository.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == catalog* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node --test --test-concurrency=1 test/mbt/unit/stock-check-catalog.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == parser* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node --test --test-concurrency=1 test/mbt/unit/stock-check-unilock-dom.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
elif [[ "$stock_check_stage" == red || "$stock_check_stage" == unit* ]]; then
  "${stock_check_compose[@]}" run --rm --no-deps test node --test --test-concurrency=1 test/mbt/unit/stock-check-domain.test.js test/mbt/unit/stock-check-vault.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
else
  "${stock_check_compose[@]}" up -d --no-build db
  "${stock_check_compose[@]}" run --rm test npm run migrate 2>&1 | tee "$stock_check_artifacts/$stock_check_stage-migrate.log"
  "${stock_check_compose[@]}" run --rm test node --test --test-concurrency=1 test/mbt/unit/stock-check-domain.test.js test/mbt/unit/stock-check-vault.test.js 2>&1 | tee "$stock_check_artifacts/$stock_check_stage.log"
fi
