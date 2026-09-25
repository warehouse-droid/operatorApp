#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
env_tool="$server_root/tools/aggregate-test-env.sh"
artifacts="$server_root/test-artifacts/aggregate-confirmation-date"
mkdir -p "$artifacts"
bash "$env_tool" start
trap 'bash "$env_tool" stop' EXIT
bash "$env_tool" runner
bash "$env_tool" exec npm run migrate > "$artifacts/migrate.log" 2>&1
bash "$env_tool" exec node tools/aggregate-checks.mjs static > "$artifacts/static.log" 2>&1
bash "$env_tool" exec node node_modules/eslint/bin/eslint.js --config tools/aggregate-eslint.config.mjs \
  tools/aggregate-confirmation-date-checks.mjs test/support/aggregate-confirmation-date-mutation-loader.mjs >> "$artifacts/static.log" 2>&1
bash "$env_tool" exec node node_modules/c8/bin/c8.js --include=src/aggregate-request-domain.js --include=src/aggregate-request-repository.js \
  --report-dir=test-artifacts/aggregate-confirmation-date-coverage --reporter=json --reporter=text \
  npm run test:aggregate-requests > "$artifacts/tests-coverage.log" 2>&1
bash "$env_tool" exec node tools/aggregate-confirmation-date-checks.mjs coverage > "$artifacts/coverage.log" 2>&1
bash "$env_tool" exec node tools/aggregate-confirmation-date-checks.mjs mutations > "$artifacts/mutations.log" 2>&1
bash "$env_tool" exec node tools/aggregate-confirmation-date-checks.mjs health > "$artifacts/suite-health.log" 2>&1
bash "$env_tool" exec node --test test/mbt/unit/operator-yard-assets.test.js test/mbt/unit/stock-request-ui-contract.test.js > "$artifacts/neighbors.log" 2>&1
bash "$env_tool" exec node test/support/scan-diff-secrets.mjs src/aggregate-request-domain.js src/aggregate-request-repository.js \
  public/scm-aggregate-alert.js public/app-sidebar.js public/aggregate-requests-i18n.js public/aggregate-requests.js \
  public/aggregate-requester.js public/aggregate-requests.css public/aggregate-requests.html public/scm-stock-requests.html \
  public/operator.html public/field-sales/index.html \
  tools/aggregate-scm-alert-date-deploy.py tools/aggregate-confirmation-date-checks.mjs \
  test/support/aggregate-confirmation-date-mutation-loader.mjs > "$artifacts/secrets.log" 2>&1
docker exec mbbs-aggregate-requests-runner tar -C /app/test-artifacts -cf - . | tar -C "$artifacts" -xf -
cp "$artifacts/aggregate-confirmation-date/coverage.json" "$artifacts/coverage.json"
cp "$artifacts/aggregate-confirmation-date/mutations.json" "$artifacts/mutations.json"
python3 tools/aggregate-scm-alert-date-deploy.py record
echo "Aggregate confirmation date checks passed."
