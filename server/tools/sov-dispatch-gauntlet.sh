#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact="$repo_root/server/test-artifacts/sov-dispatch"
mkdir -p "$artifact/final" "$artifact/baseline"
run() { bash server/tools/sov-dispatch-run.sh "$@"; }
focused() { SOV_TEST_DATABASE=sov_focused run "$@"; }
baseline() { SOV_BASELINE=1 SOV_TEST_DATABASE=sov_focused run "$@"; }
if [[ ! -e "$artifact/baseline/src/server.js" ]]; then
  cp -a server/src server/public "$artifact/baseline/"
  patch --silent --reverse -p1 -d "$artifact/baseline" < server/test/support/sov-dispatch-baseline.patch
fi
run node -p 'JSON.stringify({node:process.version,fastCheck:require("fast-check/package.json").version,eslint:require("eslint/package.json").version,typescript:require("typescript/package.json").version,c8:require("c8/package.json").version})' > "$artifact/final/versions.json"
if ! docker exec mbbs-sov-dispatch-db psql -U mbt_test -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='sov_focused'" | rg -q '^1$'; then
  docker exec mbbs-sov-dispatch-db createdb -U mbt_test sov_focused
fi
focused npm run migrate > "$artifact/final/focused-migrate.log" 2>&1
runtime=(src/dispatch-sales-order-locations.js src/sov-dispatch-repair.js src/dispatch-load-assignment.js
  src/dispatch-plan-order-projection.js src/scm-dependency-plan-reconciler.js src/dispatch-pickup-visits.js
  src/dispatch-repository.js src/driver-repository.js src/dispatch-plan-repository.js src/server.js)
tests=(test/dispatch/unit/sov-dispatch.test.js test/dispatch/frontend/sov-dispatch.test.js test/dispatch/integration/sov-dispatch.test.js)
coverage_args=()
for file in "${runtime[@]}" public/dispatch.js; do coverage_args+=("--include=$file"); done
focused node node_modules/c8/bin/c8.js --all=false --check-coverage=false "${coverage_args[@]}" \
  --temp-directory=/app/test-artifacts/sov-dispatch/final/c8 --report-dir=/app/test-artifacts/sov-dispatch/final/coverage \
  --reporter=json --reporter=json-summary --reporter=text node --test --test-concurrency=1 "${tests[@]}" > "$artifact/final/focused.log" 2>&1
focused npm run test:driver-live-route-prefix-lock > "$artifact/final/route-prefix.log" 2>&1
regressions=(test/dispatch/frontend/dispatch-required-pickups.test.js test/dispatch/integration/dispatch-required-pickups-save.test.js
  test/dispatch/unit/sales-order-cargo-integrity.red.test.js test/dispatch/unit/dispatch-repeat-pickup-visits.red.test.js
  test/dispatch/property/dispatch-repeat-pickup-visits.property.test.js test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js
  test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js)
focused node --test --test-concurrency=1 "${regressions[@]}" > "$artifact/final/regressions.log" 2>&1 || true
baseline node --test test/dispatch/unit/dispatch-repeat-pickup-visits.red.test.js > "$artifact/final/regressions-baseline.log" 2>&1 || true
run node tools/sov-dispatch-mutations.mjs > "$artifact/final/mutation.log" 2>&1
for test_file in "${tests[2]}" "${tests[0]}" "${tests[1]}"; do
  focused node --test "$test_file" >> "$artifact/final/reordered.log" 2>&1
done
run npm run typecheck:mbt > "$artifact/final/types.log" 2>&1 || true
baseline npm run typecheck:mbt > "$artifact/final/types-baseline.log" 2>&1 || true
run node node_modules/eslint/bin/eslint.js --config test/support/sov-eslint.config.mjs --format json \
  "${runtime[@]}" "${tests[@]}" test/support/sov-dispatch-browser.mjs tools/sov-dispatch-maintenance.mjs tools/sov-dispatch-mutations.mjs \
  > "$artifact/final/lint.json" 2>&1 || true
baseline node node_modules/eslint/bin/eslint.js --config test/support/sov-eslint.config.mjs --format json \
  "${runtime[@]:2}" > "$artifact/final/lint-baseline.json" 2>&1 || true
for file in "${runtime[@]}" public/dispatch.js tools/sov-dispatch-maintenance.mjs; do run node --check "$file"; done
run node test/support/scan-diff-secrets.mjs "${runtime[@]}" "${tests[@]}" tools/sov-dispatch-maintenance.mjs \
  tools/sov-dispatch-mutations.mjs > "$artifact/final/secrets.log" 2>&1
if [[ "${SOV_SKIP_FULL:-0}" != 1 ]]; then
  run npm run migrate > "$artifact/final/migrate.log" 2>&1
  run npm test > "$artifact/final/mbt.log" 2>&1 || true
fi
baseline node --test --test-concurrency=1 test/mbt/infrastructure/p3-gauntlet-contract.test.js \
  test/mbt/infrastructure/production-runtime-contract.test.js > "$artifact/final/mbt-baseline-failures.log" 2>&1 || true
python3 server/tools/sov-dispatch-evidence.py
git diff --check
