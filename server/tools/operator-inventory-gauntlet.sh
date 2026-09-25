#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
env_tool=tools/operator-inventory-env.sh
artifacts="$PWD/test-artifacts/operator-inventory"
mkdir -p "$artifacts"
bash "$env_tool" stop
trap 'bash "$env_tool" stop' EXIT
bash "$env_tool" start
bash "$env_tool" exec npm run migrate > "$artifacts/migration.log" 2>&1
bash "$env_tool" exec node tools/operator-inventory-static.mjs > "$artifacts/static.log" 2>&1
bash "$env_tool" exec node tools/operator-inventory-checks.mjs types > "$artifacts/types.log" 2>&1
bash "$env_tool" exec node node_modules/c8/bin/c8.js --all \
  --include='src/inventory-damage-*.js' --include=src/inventory-workflow-domain.js --include=src/count-sheet-repository.js \
  --include=src/operator-inventory-router.js --include=public/counting-calculator.js \
  --temp-directory=test-artifacts/operator-inventory/c8 --report-dir=test-artifacts/operator-inventory/coverage \
  --reporter=text --reporter=json --reporter=json-summary npm run test:operator-inventory > "$artifacts/focused.log" 2>&1
bash "$env_tool" exec node tools/operator-inventory-migration.mjs > "$artifacts/rollback.log" 2>&1
bash "$env_tool" exec node tools/operator-inventory-mutations.mjs > "$artifacts/mutations.log" 2>&1
bash "$env_tool" exec node tools/operator-inventory-checks.mjs shuffle > "$artifacts/shuffle.log" 2>&1
# Compare rather than hiding the repository's recorded pre-existing failures.
bash "$env_tool" exec npm test > "$artifacts/full.log" 2>&1 || true
docker exec -i mbbs-operator-inventory-test-runner sh -c 'cat > /app/test-artifacts/operator-inventory/full.log' < "$artifacts/full.log"
bash "$env_tool" exec node tools/operator-inventory-checks.mjs compare > "$artifacts/comparison.log" 2>&1
bash "$env_tool" exec node test/support/scan-diff-secrets.mjs \
  src/inventory-workflow-domain.js src/inventory-damage-repository.js src/inventory-damage-service.js src/inventory-damage-netsuite.js \
  src/count-sheet-repository.js src/operator-inventory-router.js public/operator-inventory.js public/counting-calculator.js \
  public/control-count-sheets.js tools/operator-inventory-env.sh tools/operator-inventory-gauntlet.sh > "$artifacts/secrets.log" 2>&1
bash "$env_tool" exec node tools/operator-inventory-checks.mjs source > "$artifacts/source.log" 2>&1
docker exec mbbs-operator-inventory-test-runner tar -C /app/test-artifacts -cf - . | tar -C "$artifacts" -xf -
echo "Inventory checks completed: $artifacts"
