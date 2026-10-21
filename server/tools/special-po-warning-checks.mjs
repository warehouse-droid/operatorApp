import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { isolatedRun } from './dispatch-source-decision-checks.mjs';

const mode = process.argv[2] || 'final';
const files = [
  'test/mbt/unit/special-stock-request-service.red.test.js',
  'test/mbt/unit/special-stock-request-domain.red.test.js',
  'test/mbt/unit/special-stock-request-netsuite.red.test.js',
  'test/mbt/unit/special-stock-request-policy.red.test.js',
  'test/mbt/unit/special-local-adjustments.test.js',
  'test/mbt/unit/special-workflow-description-race.test.js',
  'test/mbt/unit/special-so-creation-confirmation.test.js',
  'test/mbt/unit/special-so-creation-marker.test.js',
  'test/mbt/integration/special-local-adjustments.test.js',
  'test/mbt/integration/special-so-creation-confirmation.test.js',
  'test/mbt/integration/special-so-creation-webhook.test.js',
  'test/mbt/integration/special-order-rejection-unlock.test.js',
  'test/mbt/integration/special-manual-so-link.test.js',
  'test/mbt/integration/special-workflow-description-race.test.js',
  'test/mbt/integration/special-standalone-po.test.js',
  'test/mbt/property/special-order-rejection.property.test.js',
  'test/mbt/property/special-stock-request-domain.property.test.js'
];
if (mode !== 'baseline') files.push('test/mbt/integration/special-po-warning.test.js');
const order = name => [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 997, 111);
files.sort((a, b) => mode === 'baseline' ? a.localeCompare(b) : order(a) - order(b));
const results = [];
for (const file of files) {
  const result = await isolatedRun(file, { prefix: `po-warning-${mode}` });
  results.push(result);
  console.log(JSON.stringify(result));
}
writeFileSync(`test-artifacts/${mode}-regressions.json`, JSON.stringify(results, null, 2));
if (mode !== 'baseline') {
  const baseline = JSON.parse(readFileSync('test-artifacts/baseline-regressions.json', 'utf8'));
  for (const result of results) {
    if (result.exit === 0) continue;
    assert.deepEqual(result, baseline.find(row => row.file === result.file), `New regression: ${result.file}`);
  }
}
console.log(JSON.stringify({ mode, tests: results.reduce((n, r) => n + r.tests, 0),
  pass: results.reduce((n, r) => n + r.pass, 0), fail: results.reduce((n, r) => n + r.fail, 0) }));
if (mode !== 'baseline') await import('./special-po-warning-quality.mjs');
