#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
checks="$server_root/tools/maps-daily-capacity-checks.sh"
out="$server_root/test-artifacts/maps-daily-capacity"
mkdir -p "$out"
bash "$checks" setup > "$out/migration.log" 2>&1
bash "$checks" run tools/maps-daily-capacity-migration.mjs > "$out/migration-rollback.log" 2>&1
bash "$checks" run tools/maps-daily-capacity-baseline.mjs > "$out/baseline-check.log" 2>&1
bash "$checks" run tools/maps-daily-capacity-static.mjs > "$out/static.log" 2>&1
bash "$checks" run test/support/scan-diff-secrets.mjs src/google-maps-usage-policy.js src/google-maps-usage-repository.js src/server.js public/control.js public/control.css public/admin.html migrations/219_google_maps_daily_capacity.sql > "$out/secrets.log" 2>&1
bash "$checks" run tools/maps-daily-capacity-mutations.mjs > "$out/mutations.log" 2>&1
bash "$checks" run node_modules/c8/bin/c8.js --include=src/google-maps-usage-policy.js --include=src/google-maps-usage-repository.js --temp-directory=/tmp/maps-daily-c8 --reports-dir=test-artifacts/maps-daily-capacity/coverage --reporter=text --reporter=json --reporter=json-summary --check-coverage --lines=95 --statements=95 --functions=90 --branches=75 node --test --test-concurrency=1 test/mbt/unit/google-maps-usage-policy.red.test.js test/mbt/property/google-maps-usage-policy.property.test.js test/mbt/concurrency/google-maps-usage-budget.concurrency.test.js test/mbt/unit/google-maps-daily-capacity.test.js test/mbt/integration/google-maps-daily-capacity.test.js test/mbt/integration/google-maps-daily-http.test.js > "$out/coverage.log" 2>&1
bash "$checks" run tools/maps-daily-capacity-browser.mjs > "$out/browser.log" 2>&1
python3 "$server_root/tools/maps-daily-capacity-coverage.py" > "$out/changed-line-coverage.log"
bash "$checks" run tools/maps-daily-capacity-suite-health.mjs > "$out/suite-health.log" 2>&1
# Retain the full result, including the known pre-existing Dispatch contract
# failure. The evidence command requires an exact match to the saved baseline.
if bash "$checks" test > "$out/tests.log" 2>&1; then
  echo "Focused suite passed."
else
  echo "Focused suite reported a failure; comparing it with the pre-change baseline."
fi
bash "$checks" run tools/maps-daily-capacity-evidence.mjs
