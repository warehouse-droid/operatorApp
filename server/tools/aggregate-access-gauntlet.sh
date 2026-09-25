#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root/.."
env_tool="$server_root/tools/aggregate-test-env.sh"
artifact_root="$server_root/test-artifacts/aggregate-access-flow"
mkdir -p "$artifact_root"
bash "$env_tool" stop
trap 'bash "$env_tool" stop' EXIT
bash "$env_tool" start
bash "$env_tool" runner
bash "$env_tool" exec node src/migrate.js > "$artifact_root/migrate.log" 2>&1
bash "$env_tool" exec node tools/aggregate-access-checks.mjs static > "$artifact_root/static.log" 2>&1
bash "$env_tool" exec node tools/aggregate-access-migration-check.mjs > "$artifact_root/migration-check.log" 2>&1
# Use changed-line coverage below; unmodified auth-repository functions are outside this change.
bash "$env_tool" exec node node_modules/c8/bin/c8.js --all --check-coverage=false \
  '--include=src/aggregate-request-*.js' --include=src/auth-repository.js \
  --report-dir=test-artifacts/aggregate-access-server-coverage --reporter=text --reporter=json --reporter=json-summary \
  node --test --test-concurrency=1 \
  test/mbt/unit/aggregate-request-domain.test.js test/mbt/unit/aggregate-request-access.test.js \
  test/mbt/integration/aggregate-request-repository.test.js test/mbt/integration/aggregate-request-http.test.js \
  test/mbt/integration/aggregate-request-access.test.js test/mbt/integration/aggregate-request-browser.test.js \
  > "$artifact_root/tests.log" 2>&1
bash "$env_tool" exec node tools/aggregate-access-checks.mjs coverage > "$artifact_root/coverage.log" 2>&1
bash "$env_tool" exec node --test --test-concurrency=1 \
  test/mbt/unit/stock-request-ui-contract.test.js test/mbt/unit/stock-request-server-contract.test.js \
  test/mbt/unit/special-stock-request-wiring.red.test.js test/mbt/unit/special-stock-request-domain.red.test.js \
  test/mbt/property/special-stock-request-domain.property.test.js test/mbt/unit/operator-delivery-refresh.test.js \
  > "$artifact_root/neighbors.log" 2>&1
bash "$env_tool" exec node --test --test-name-pattern='main sidebar modules follow|Aggregate navigation' \
  test/mbt/unit/operations-navigation-enhancements.test.js > "$artifact_root/navigation.log" 2>&1
bash "$env_tool" exec node tools/aggregate-access-mutations.mjs > "$artifact_root/mutations.log" 2>&1
bash "$env_tool" exec node tools/aggregate-checks.mjs shuffle > "$artifact_root/suite-health.log" 2>&1
bash "$env_tool" exec node tools/aggregate-access-checks.mjs source > "$artifact_root/source.log" 2>&1
docker exec mbbs-aggregate-requests-runner tar -C /app/test-artifacts -cf - . | tar --no-same-owner --no-same-permissions --no-overwrite-dir -C "$artifact_root" -xf -
if [[ -n "${SUDO_UID:-}" ]]; then chown -R "$SUDO_UID:$SUDO_GID" "$artifact_root"; fi
if [[ "${1:-}" != '--focused' ]]; then
  bash "$env_tool" exec npm test > "$artifact_root/final-full.log" 2>&1 || true
  python3 "$server_root/tools/aggregate-regression.py" compare \
    "$server_root/test/aggregate-access-existing-baseline.json" "$artifact_root/final-full.log" "$artifact_root/full-regression.json"
fi
printf 'Aggregate access and workflow evidence: %s\n' "$artifact_root"
