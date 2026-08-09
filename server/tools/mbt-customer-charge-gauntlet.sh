#!/bin/sh
set -eu

node --test --test-concurrency=1 \
  test/mbt/unit/customer-charge-calculator-boundaries.test.js \
  test/mbt/unit/customer-charge-request-service-boundaries.test.js \
  test/mbt/contracts/customer-charge-regression.test.js \
  test/mbt/property/customer-charge-calculator.property.test.js \
  test/mbt/integration/customer-charge-migration.test.js \
  test/mbt/integration/customer-charge-request-workflow.test.js \
  test/mbt/integration/frontdesk-http.test.js \
  test/mbt/integration/rate-card-configuration-http.test.js \
  test/mbt/concurrency/customer-charge-confirmation-races.test.js \
  test/mbt/unit/customer-charge-frontdesk-ui-contract.test.js \
  test/mbt/unit/customer-charge-admin-configuration-ui.test.js

npx c8 --all \
  --include=src/mbt/customer-charge-calculator.js \
  --include=src/mbt/customer-charge-request-service.js \
  --check-coverage \
  --lines=95 \
  --statements=95 \
  --functions=95 \
  --branches=90 \
  --temp-directory=/tmp/mbt-customer-charge-gauntlet-c8 \
  --report-dir=/tmp/mbt-customer-charge-gauntlet-coverage \
  --reporter=text \
  node --test --test-concurrency=1 \
    test/mbt/unit/customer-charge-calculator-boundaries.test.js \
    test/mbt/unit/customer-charge-request-service-boundaries.test.js \
    test/mbt/contracts/customer-charge-regression.test.js \
    test/mbt/property/customer-charge-calculator.property.test.js \
    test/mbt/integration/customer-charge-migration.test.js \
    test/mbt/integration/customer-charge-request-workflow.test.js \
    test/mbt/concurrency/customer-charge-confirmation-races.test.js

npm run typecheck:mbt

npx eslint --config eslint.mbt.config.js --max-warnings=0 \
  src/mbt/customer-charge-calculator.js \
  src/mbt/customer-charge-request-service.js \
  src/mbt/frontdesk-service.js \
  src/mbt/router.js \
  test/mbt/contracts/customer-charge-regression.test.js \
  test/mbt/contracts/customer-charge-scenario-catalog.js \
  test/mbt/property/customer-charge-calculator.property.test.js \
  test/mbt/unit/customer-charge-calculator-boundaries.test.js \
  test/mbt/unit/customer-charge-request-service-boundaries.test.js \
  test/mbt/integration/customer-charge-migration.test.js \
  test/mbt/integration/customer-charge-request-workflow.test.js \
  test/mbt/integration/frontdesk-http.test.js \
  test/mbt/integration/rate-card-configuration-http.test.js \
  test/mbt/concurrency/customer-charge-confirmation-races.test.js \
  test/mbt/unit/customer-charge-frontdesk-ui-contract.test.js \
  test/mbt/unit/customer-charge-admin-configuration-ui.test.js \
  test/mbt/e2e/p3-frontdesk.spec.js \
  test/mbt/e2e/p3-config-friendly-editor.spec.js

node --check public/mbt-frontdesk.js
node --check public/mbt-shell.js

npm run mutate:mbt:customer-charge
