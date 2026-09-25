#!/usr/bin/env bash
set -Eeuo pipefail
cd /app
: "${MBT_TEST_ISOLATED:?Disposable database only}"
field_artifacts="${FIELD_SALES_ARTIFACT_DIR:-/artifacts}"
./node_modules/.bin/eslint -c tools/field-sales-eslint.config.mjs src/field-sales public/field-sales test/field-sales tools/field-sales-customer-links-browser.mjs tools/field-sales-combined-quotes-browser.mjs tools/field-sales-mbbs-settings.mjs > "$field_artifacts/lint.log" 2>&1
./node_modules/.bin/tsc --allowJs --checkJs --noEmit --target es2022 --module nodenext --skipLibCheck public/field-sales/domain.js public/field-sales/pricing.js public/field-sales/identity.js public/field-sales/quote-drafts.js > "$field_artifacts/types.log" 2>&1
node --test --test-concurrency=1 test/field-sales/*.test.js > "$field_artifacts/final-tests.log" 2>&1
node tools/field-sales-customer-links-browser.mjs > "$field_artifacts/final-browser.log" 2>&1
node tools/field-sales-combined-quotes-browser.mjs > "$field_artifacts/combined-browser.log" 2>&1
