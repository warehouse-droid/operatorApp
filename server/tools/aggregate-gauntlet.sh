#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root/.."
env_tool="$server_root/tools/aggregate-test-env.sh"
artifact_root="$server_root/test-artifacts/aggregate-validation"
mkdir -p "$artifact_root"

# This entry point only manages the dedicated feature test containers.
bash "$env_tool" stop
trap 'bash "$env_tool" stop' EXIT
bash "$env_tool" start
bash "$env_tool" runner
bash "$env_tool" exec npm run migrate > "$artifact_root/migrate.log" 2>&1
bash "$env_tool" exec node tools/aggregate-migration-check.mjs | tee "$artifact_root/migration-check.log"
bash "$env_tool" exec node tools/aggregate-checks.mjs static | tee "$artifact_root/static.log"
bash "$env_tool" exec node node_modules/c8/bin/c8.js --all --include='src/aggregate-request-*.js' \
  --report-dir=test-artifacts/aggregate-server-coverage --reporter=text --reporter=json --reporter=json-summary \
  --check-coverage --lines=95 --statements=95 --functions=95 --branches=90 \
  npm run test:aggregate-requests | tee "$artifact_root/tests.log"
bash "$env_tool" exec node tools/aggregate-checks.mjs browser-coverage | tee "$artifact_root/browser-coverage.log"
bash "$env_tool" exec node --test --test-concurrency=1 \
  test/mbt/unit/stock-request-ui-contract.test.js test/mbt/unit/stock-request-server-contract.test.js \
  test/mbt/unit/special-stock-request-wiring.red.test.js test/mbt/unit/special-stock-request-domain.red.test.js \
  test/mbt/property/special-stock-request-domain.property.test.js | tee "$artifact_root/neighbor-tests.log"
bash "$env_tool" exec node --test test/mbt/unit/operator-delivery-refresh.test.js | tee "$artifact_root/cache-tests.log"
bash "$env_tool" exec node --test --test-name-pattern='main sidebar modules follow' \
  test/mbt/unit/operations-navigation-enhancements.test.js | tee "$artifact_root/navigation-tests.log"
bash "$env_tool" exec npm run mutate:aggregate-requests | tee "$artifact_root/mutations.log"
bash "$env_tool" exec node tools/aggregate-checks.mjs shuffle | tee "$artifact_root/suite-health.log"
bash "$env_tool" exec node tools/aggregate-checks.mjs source | tee "$artifact_root/source.log"
docker exec mbbs-aggregate-requests-runner tar -C /app/test-artifacts -cf - . | tar -C "$artifact_root" -xf -
echo "Aggregate validation artifacts: $artifact_root"
