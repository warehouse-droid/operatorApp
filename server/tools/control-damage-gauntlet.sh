#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export INVENTORY_TEST_NAME=mbbs-operator-inventory-baseline
artifacts="$PWD/test-artifacts/control-damage"
mkdir -p "$artifacts"
env_tool=tools/operator-inventory-env.sh
bash "$env_tool" stop
bash "$env_tool" start
bash "$env_tool" exec npm run migrate > "$artifacts/candidate-migration.log" 2>&1
bash "$env_tool" exec node tools/control-damage-static.mjs > "$artifacts/static.log" 2>&1
bash "$env_tool" exec node tools/operator-inventory-static.mjs > "$artifacts/inventory-static.log" 2>&1
bash "$env_tool" exec node tools/operator-inventory-checks.mjs types > "$artifacts/types.log" 2>&1
coverage=(node node_modules/c8/bin/c8.js --all --check-coverage=false --include='src/control-damage-*.js' --include='src/inventory-damage-*.js' --include=src/operator-inventory-router.js --include=src/netsuite.js --include=src/server.js --temp-directory=test-artifacts/control-damage/c8 --report-dir=test-artifacts/control-damage/coverage --reporter=json --reporter=json-summary)
# Gate changed executable lines below, not the global percentage of large pre-existing modules.
bash "$env_tool" exec "${coverage[@]}" node --test --test-concurrency=1 \
 test/control-damage-domain.test.js test/control-damage-service.test.js test/control-damage-review.test.js test/control-damage-http.test.js test/control-damage-browser.test.js test/control-damage-netsuite.test.js \
 test/operator-inventory-domain.test.js test/operator-inventory-adapter.test.js test/operator-inventory-photos.test.js test/operator-inventory-count.test.js test/operator-inventory-damage.test.js test/operator-inventory-http.test.js test/operator-inventory-browser.test.js > "$artifacts/focused.log" 2>&1
bash "$env_tool" exec "${coverage[@]}" --clean=false node tools/control-damage-startup.mjs > "$artifacts/startup.log" 2>&1
bash "$env_tool" exec node tools/control-damage-migration.mjs > "$artifacts/rollback.log" 2>&1
bash "$env_tool" exec node tools/control-damage-coverage.mjs > "$artifacts/changed-coverage.log" 2>&1
bash "$env_tool" exec node tools/control-damage-checks.mjs mutations > "$artifacts/mutations.log" 2>&1
bash "$env_tool" exec node tools/control-damage-checks.mjs shuffle > "$artifacts/shuffle.log" 2>&1
bash "$env_tool" exec node test/support/scan-diff-secrets.mjs \
 src/control-damage-domain.js src/control-damage-service.js src/control-damage-netsuite.js src/control-damage-review.js src/control-damage-router.js public/control-damage.js \
 tools/control-damage-deploy.py tools/control-damage-live.py tools/control-damage-checks.mjs tools/control-damage-coverage.mjs tools/control-damage-gauntlet.sh > "$artifacts/secrets.log" 2>&1
if [[ "${1:-}" != --focused ]]; then
 bash "$env_tool" exec npm test > "$artifacts/full.log" 2>&1 || true
 docker exec -i "$INVENTORY_TEST_NAME-runner" sh -c 'mkdir -p /app/test-artifacts/operator-inventory; cat > /app/test-artifacts/operator-inventory/full.log' < "$artifacts/full.log"
 bash "$env_tool" exec node tools/operator-inventory-checks.mjs compare > "$artifacts/comparison.log" 2>&1
 docker exec "$INVENTORY_TEST_NAME-runner" cat /app/test-artifacts/operator-inventory/comparison.json > "$artifacts/comparison.json"
fi
bash "$env_tool" exec node tools/control-damage-checks.mjs source > "$artifacts/source.log" 2>&1
docker exec "$INVENTORY_TEST_NAME-runner" tar -C /app/test-artifacts/control-damage -cf - . | tar -C "$artifacts" -xf -
echo "Control damage checks completed: $artifacts"
