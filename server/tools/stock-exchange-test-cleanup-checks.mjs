import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const file = 'tools/stock-exchange-deleted-test-cleanup.mjs';
const source = readFileSync(file, 'utf8');
const testArgs = ['--test', '--test-force-exit', '--test-concurrency=1', 'test/mbt/integration/stock-exchange-test-cleanup.test.js'];
const run = (args, env = process.env) => spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 90000, maxBuffer: 4e6 });
const baseline = run(['node_modules/c8/bin/c8.js', '--include', file, '--reporter=json-summary', '--reports-dir=test-artifacts/exchange-cleanup-coverage', 'node', ...testArgs]);
assert.ifError(baseline.error);
assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
const coverage = JSON.parse(readFileSync('test-artifacts/exchange-cleanup-coverage/coverage-summary.json', 'utf8')).total;
const mutants = [
  ['existing-transfer', "assert.ok(missing, 'Inventory Transfer still exists; cleanup refused');", "assert.ok(true, 'Inventory Transfer still exists; cleanup refused');"],
  ['shared-month', "assert.deepEqual(postings.rows.map(row => Number(row.record_id)), [target.recordId], 'Another exchange now uses this month; inspect before cleanup');", ''],
  ['stale-month-link', 'SET transfer_id=NULL,transfer_ref=NULL WHERE id=$1', 'SET transfer_id=transfer_id,transfer_ref=transfer_ref WHERE id=$1']
];
for (const [name, old, replacement] of mutants) {
  assert.equal(source.split(old).length, 2, name);
  const mutant = `/app/test-artifacts/exchange-cleanup-${name}.mjs`;
  writeFileSync(mutant, source.replace(old, replacement).replaceAll("'../src/", "'/app/src/"));
  const result = run(testArgs, { ...process.env, EXCHANGE_CLEANUP_MODULE: `file://${mutant}` });
  assert.ifError(result.error);
  assert.equal(result.status, 1, `${name} survived: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /not ok/);
  console.log(`Cleanup mutation killed: ${name}`);
}
assert.equal(readFileSync(file, 'utf8'), source);
console.log(JSON.stringify({ passed: true, tests: 5, mutationsKilled: 3, coverage,
  sourceHash: createHash('sha256').update(source).digest('hex') }));
