#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root/.."
env_tool="$server_root/tools/aggregate-test-env.sh"
artifacts="$server_root/test-artifacts/aggregate-next-request"
mkdir -p "$artifacts"
bash "$env_tool" stop
trap 'bash "$env_tool" stop' EXIT
bash "$env_tool" start
bash "$env_tool" runner
bash "$env_tool" exec node src/migrate.js > "$artifacts/migrate.log" 2>&1
bash "$env_tool" exec node tools/aggregate-next-request-checks.mjs static > "$artifacts/static.log" 2>&1
bash "$env_tool" exec node node_modules/c8/bin/c8.js --all --check-coverage=false \
  '--include=src/aggregate-request-*.js' --report-dir=test-artifacts/aggregate-next-request-coverage \
  --reporter=json --reporter=json-summary node --test --test-concurrency=1 \
  test/mbt/unit/aggregate-request-domain.test.js test/mbt/unit/aggregate-request-access.test.js \
  test/mbt/integration/aggregate-request-repository.test.js test/mbt/integration/aggregate-request-http.test.js \
  test/mbt/integration/aggregate-request-access.test.js test/mbt/integration/aggregate-request-browser.test.js \
  > "$artifacts/tests.log" 2>&1
bash "$env_tool" exec node tools/aggregate-next-request-checks.mjs coverage > "$artifacts/coverage.log" 2>&1
bash "$env_tool" exec node tools/aggregate-next-request-migration.mjs > "$artifacts/migration-rehearsal.log" 2>&1
bash "$env_tool" exec node tools/aggregate-next-request-concurrency.mjs > "$artifacts/concurrency.log" 2>&1
bash "$env_tool" exec node tools/aggregate-next-request-checks.mjs mutations > "$artifacts/mutations.log" 2>&1
bash "$env_tool" exec node tools/aggregate-checks.mjs shuffle > "$artifacts/suite-health.log" 2>&1
docker exec mbbs-aggregate-requests-runner tar -C /app/test-artifacts -cf - . |
  tar --no-same-owner --no-same-permissions --no-overwrite-dir -C "$artifacts" -xf -
if [[ -n "${SUDO_UID:-}" ]]; then chown -R "$SUDO_UID:$SUDO_GID" "$artifacts"; fi
if [[ "${1:-}" != '--focused' ]]; then
  bash "$env_tool" exec npm test > "$artifacts/full.log" 2>&1 || true
  python3 "$server_root/tools/aggregate-regression.py" compare \
    "$server_root/test/aggregate-access-existing-baseline.json" "$artifacts/full.log" "$artifacts/full-regression.json"
fi
printf 'Aggregate next-request verification: %s\n' "$artifacts"
