import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const suites = [
  'test/mbt/unit/special-quote-discount-summary.test.js',
  'test/field-sales/company-pdf.test.js',
  'test/mbt/unit/special-quote-packing.test.js',
  'test/mbt/unit/special-quote-requester.test.js',
  'test/mbt/unit/special-workflow-documents.test.js',
  'test/mbt/unit/special-workflow-pdf-stream-length.test.js',
  'test/mbt/unit/special-workflow-pricing.test.js',
  'test/mbt/unit/special-discount-summary.test.js',
  'test/field-sales/quote-validation.test.js',
  'test/field-sales/quote-lifecycle.test.js',
  'test/field-sales/quote-evidence.test.js',
  'test/field-sales/customer-quotes.test.js',
  'test/field-sales/combined-quotes.test.js'
];
const newTests = 'test/mbt/unit/special-quote-breakdown.test.js';

if (process.argv[1].endsWith('special-quote-breakdown-tests.mjs')) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const baseline = process.argv.includes('--baseline');
  const files = baseline ? suites : [...suites, newTests];
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files],
    { encoding: 'utf8', maxBuffer: 20000000 });
  const output = result.stdout + result.stderr;
  writeFileSync(`test-artifacts/${baseline ? 'baseline' : 'suite'}.tap`, output);
  const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
  const allowed = baseline ? failures : JSON.parse(readFileSync('test-artifacts/baseline-tests.json')).failures;
  const newFailures = failures.filter(name => !allowed.includes(name));
  assert(result.status === 0 || result.status === 1 && failures.length > 0, output);
  const record = { passed: Number(output.match(/^# pass (\d+)/m)?.[1] || 0), failures, newFailures, files };
  writeFileSync(`test-artifacts/${baseline ? 'baseline-tests' : 'suite-results'}.json`, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
  assert.deepEqual(newFailures, []);
}
