#!/usr/bin/env bash
set -Eeuo pipefail
cd /app
: "${MBT_TEST_ISOLATED:?Disposable database only}"
field_artifacts="${FIELD_SALES_ARTIFACT_DIR:-/artifacts}"
rm -rf "$field_artifacts/coverage" "$field_artifacts/combined-coverage"
rm -f "$field_artifacts/changed-lines.json" "$field_artifacts/mutations.json" "$field_artifacts/customer-browser.json" "$field_artifacts/existing-customers-browser.json" "$field_artifacts/customer-links-browser.json" "$field_artifacts/browser-v8.json" "$field_artifacts/existing-customers-browser-v8.json"
./node_modules/.bin/eslint -c tools/field-sales-eslint.config.mjs src/field-sales public/field-sales test/field-sales netsuite-field-sales-restlet.js tools/field-sales-existing-customers-browser.mjs tools/field-sales-combined-quotes-browser.mjs tools/field-sales-customer-links-browser.mjs tools/field-sales-existing-customers-mutations.mjs tools/field-sales-existing-customers-settings.mjs > "$field_artifacts/lint.log" 2>&1
./node_modules/.bin/tsc --allowJs --checkJs --noEmit --target es2022 --module nodenext --skipLibCheck public/field-sales/domain.js public/field-sales/pricing.js public/field-sales/identity.js public/field-sales/quote-drafts.js > "$field_artifacts/types.log" 2>&1
./node_modules/.bin/c8 --check-coverage=false --all --include 'src/field-sales/**' --include 'public/field-sales/**' --include 'netsuite-field-sales-restlet.js' --exclude '**/fonts/**' --reporter=json --reporter=text --report-dir "$field_artifacts/coverage" node --test --test-concurrency=1 test/field-sales/*.test.js > "$field_artifacts/final-tests.log" 2>&1
node tools/field-sales-existing-customers-browser.mjs > "$field_artifacts/existing-browser.log" 2>&1
node tools/field-sales-combined-quotes-browser.mjs > "$field_artifacts/final-browser.log" 2>&1
node tools/field-sales-customer-links-browser.mjs > "$field_artifacts/site-browser.log" 2>&1
node --input-type=module -e 'import{readFileSync,writeFileSync}from"node:fs";const d=process.env.FIELD_SALES_ARTIFACT_DIR||"/artifacts";const rows=[...JSON.parse(readFileSync(d+"/browser-v8.json")),...JSON.parse(readFileSync(d+"/existing-customers-browser-v8.json"))];writeFileSync(d+"/browser-v8.json",JSON.stringify(rows));'
node tools/field-sales-customer-coverage.mjs > "$field_artifacts/coverage.log" 2>&1
node tools/field-sales-existing-customers-mutations.mjs > "$field_artifacts/mutations.log" 2>&1
node --input-type=module -e 'import{readdirSync}from"node:fs";import{spawnSync}from"node:child_process";let n=20260922;const files=readdirSync("test/field-sales").filter(f=>f.endsWith(".test.js"));for(let i=files.length-1;i>0;i--){n=(Math.imul(n,1664525)+1013904223)>>>0;const j=n%(i+1);[files[i],files[j]]=[files[j],files[i]];}const r=spawnSync(process.execPath,["--test","--test-concurrency=1",...files.map(f=>"test/field-sales/"+f)],{stdio:"inherit"});process.exit(r.status??1);' > "$field_artifacts/shuffled-tests.log" 2>&1
