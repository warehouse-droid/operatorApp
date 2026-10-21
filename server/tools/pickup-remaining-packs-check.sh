#!/usr/bin/env bash
set -Eeuo pipefail
node --check src/delivery-repository.js
node --check public/operator.js
node --check public/service-worker.js
node node_modules/eslint/bin/eslint.js --config eslint.mbt.config.js --max-warnings=0 \
  test/mbt/unit/pickup-remaining-packs.test.js test/mbt/integration/pickup-remaining-packs.test.js
node --test --test-concurrency=1 \
  test/mbt/unit/pickup-remaining-packs.test.js \
  test/mbt/integration/pickup-remaining-packs.test.js \
  test/mbt/unit/operator-ui-enhancements.test.js \
  test/mbt/integration/operator-ui-enhancements.test.js \
  test/mbt/unit/group-underpack-ui.test.js \
  test/mbt/integration/group-underpack.test.js \
  test/mbt/unit/operator-posting-pack-quantities.test.js \
  test/mbt/integration/operator-posting-pack-quantities.test.js \
  test/mbt/unit/operator-receiving-quantity-ui.test.js \
  test/mbt/integration/pickup-existing-if.test.js \
  test/mbt/integration/customer-pickup-yard-scope.test.js
