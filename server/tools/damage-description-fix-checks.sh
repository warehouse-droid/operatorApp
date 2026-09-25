#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
env_tool=tools/operator-inventory-env.sh
artifacts="$PWD/test-artifacts/damage-description-fix"
mkdir -p "$artifacts"
bash "$env_tool" stop
trap 'bash "$env_tool" stop' EXIT
bash "$env_tool" start
bash "$env_tool" exec npm run migrate > "$artifacts/migration.log" 2>&1
bash "$env_tool" exec node tools/operator-inventory-static.mjs > "$artifacts/static.log" 2>&1
bash "$env_tool" exec node tools/operator-inventory-checks.mjs types > "$artifacts/types.log" 2>&1
bash "$env_tool" exec node node_modules/c8/bin/c8.js --all --include='src/inventory-damage-*.js' \
  --include=src/inventory-workflow-domain.js --include=src/count-sheet-repository.js \
  --include=src/operator-inventory-router.js --include=public/counting-calculator.js \
  --temp-directory=test-artifacts/damage-description-fix/c8 --report-dir=test-artifacts/damage-description-fix/coverage \
  --reporter=text --reporter=json --reporter=json-summary npm run test:operator-inventory > "$artifacts/focused.log" 2>&1
bash "$env_tool" exec node tools/damage-description-fix-checks.mjs coverage > "$artifacts/changed-coverage.log" 2>&1
bash "$env_tool" exec node tools/damage-description-fix-checks.mjs mutations > "$artifacts/mutations.log" 2>&1
bash "$env_tool" exec node tools/operator-inventory-checks.mjs shuffle > "$artifacts/shuffle.log" 2>&1
bash "$env_tool" exec npm test > "$artifacts/full.log" 2>&1 || true
docker exec -i mbbs-operator-inventory-test-runner sh -c 'cat > /app/test-artifacts/operator-inventory/full.log' < "$artifacts/full.log"
bash "$env_tool" exec node tools/operator-inventory-checks.mjs compare > "$artifacts/comparison.log" 2>&1
bash "$env_tool" exec node test/support/scan-diff-secrets.mjs src/inventory-damage-service.js \
  test/support/damage-description-fix-mutation-loader.mjs tools/damage-description-fix-checks.mjs \
  tools/damage-description-fix-checks.sh tools/damage-description-fix-deploy.py > "$artifacts/secrets.log" 2>&1
bash "$env_tool" exec node tools/damage-description-fix-checks.mjs source > "$artifacts/source.log" 2>&1
docker exec mbbs-operator-inventory-test-runner tar -C /app/test-artifacts -cf - damage-description-fix operator-inventory | tar -C "$artifacts" -xf -
echo "Damage description checks completed: $artifacts"
