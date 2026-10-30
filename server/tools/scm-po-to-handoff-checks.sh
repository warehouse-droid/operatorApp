#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname -- "$0")/.."
check_dir="$(mktemp -d /app/test-artifacts/scm-po-to-handoff.XXXXXX)"
trap 'rm -rf -- "$check_dir"' EXIT
tests=(
  test/mbt/unit/smart-scm-po-to-handoff.test.js
  test/mbt/property/smart-scm-po-to-handoff.property.test.js
  test/mbt/unit/smart-scm-po-to-handoff-ui.test.js
  test/mbt/integration/smart-scm-po-to-handoff.test.js
  test/mbt/unit/smart-scm-phased-planning.red.test.js
  test/mbt/unit/smart-scm-phased-planning-ui.contract.test.js
  test/mbt/unit/smart-scm-blanket-split-inventory.red.test.js
  test/mbt/unit/smart-scm-skip-12441.red.test.js
  test/mbt/property/smart-scm-skip-12441.property.test.js
  test/mbt/unit/smart-scm-blanket-residual-coverage.red.test.js
  test/mbt/property/smart-scm-blanket-residual-coverage.property.test.js
  test/mbt/integration/smart-scm-phased-settings.test.js
  test/mbt/integration/split-inbound-completion.test.js
  test/mbt/integration/reconciled-split-inbound.test.js
  test/mbt/integration/regular-stock-replenishment.test.js
  test/mbt/integration/regular-stock-purchase-loads.test.js
  test/mbt/integration/smart-scm-manual-to-backorder.test.js
  test/dispatch/integration/scm-po-split-editing.test.js
  src/smart-scm-calculation-ui-harness.js
  src/smart-scm-vendor-ui-harness.js
  src/smart-scm-blanket-ui-harness.js
)
node --version
suite_failed=0
./node_modules/.bin/c8 --all=false --include=src/smart-scm-po-handoff.js \
  --temp-directory="$check_dir/v8" --report-dir="$check_dir/coverage" \
  --reporter=text --reporter=json-summary --check-coverage --lines=100 --functions=100 \
  --statements=100 --branches=100 node --test --test-concurrency=1 "${tests[@]}" \
  > "$check_dir/tests.tap" 2>&1 || suite_failed=1
node --input-type=module - "$check_dir" "$suite_failed" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const [dir, failed] = process.argv.slice(2);
const log = fs.readFileSync(dir + '/tests.tap', 'utf8');
const failures = [...log.matchAll(/^not ok \d+ - (.*)$/gm)].map(match => match[1]);
const baseline = ['/app/src/smart-scm-blanket-ui-harness.js'];
try {
  assert.deepEqual(failures, failed === '1' ? baseline : []);
  if (failed === '1') {
    assert.ok(log.includes('Smart SCM must load cache-busted asset scm-smart-exclusions.js?v=20260801-po-only-pauses-v1.'));
  }
  const coverage = JSON.parse(fs.readFileSync(dir + '/coverage/coverage-summary.json', 'utf8')).total;
  for (const name of ['lines', 'statements', 'functions', 'branches']) assert.equal(coverage[name].pct, 100);
  console.log(JSON.stringify({tests: Number(log.match(/^# tests (\d+)$/m)[1]),
    passed: Number(log.match(/^# pass (\d+)$/m)[1]), baselineFailures: failures,
    newFailures: 0, policyCoverage: coverage}));
} catch (error) {
  process.stdout.write(log);
  throw error;
}
JS
./node_modules/.bin/eslint --config tools/scm-po-to-handoff-eslint.mjs --max-warnings=0 \
  src/smart-scm-po-handoff.js test/mbt/unit/smart-scm-po-to-handoff*.test.js \
  test/mbt/property/smart-scm-po-to-handoff.property.test.js \
  test/mbt/integration/smart-scm-po-to-handoff.test.js \
  test/support/run-scm-po-to-handoff-mutations.mjs tools/scm-po-to-handoff-eslint.mjs
./node_modules/.bin/tsc --allowJs --checkJs --noEmit --skipLibCheck --strict \
  --target ES2023 --module NodeNext --moduleResolution NodeNext src/smart-scm-po-handoff.js
node --check src/smart-scm-planning-repository.js
node --check public/scm-smart-proposals.js
node test/support/run-scm-po-to-handoff-mutations.mjs
node test/support/scan-diff-secrets.mjs src/smart-scm-po-handoff.js \
  src/smart-scm-planning-repository.js public/scm-smart-proposals.js public/scm-smart.html \
  test/mbt/unit/smart-scm-po-to-handoff.test.js test/mbt/unit/smart-scm-po-to-handoff-ui.test.js \
  test/mbt/property/smart-scm-po-to-handoff.property.test.js \
  test/mbt/integration/smart-scm-po-to-handoff.test.js \
  test/support/run-scm-po-to-handoff-mutations.mjs tools/scm-po-to-handoff-checks.sh
sha256sum src/smart-scm-po-handoff.js src/smart-scm-planning-repository.js \
  public/scm-smart-proposals.js public/scm-smart.html
echo 'PO to TO handoff checks passed.'
