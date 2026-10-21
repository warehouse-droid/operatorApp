import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync('/app/src/netsuite-transaction-units.js', 'utf8');
const mutants = [
  ['multiply quantity instead of divide', 'value / factor', 'value * factor'],
  ['apply a fixed 1.3 factor to every item', 'Number(row.unit_conversion_rate)', '1.3'],
  ['leave received quantity in base units', "'netsuite_received_qty',", ''],
  ['divide the selling rate', 'value * factor : value / factor', 'value / factor : value / factor']
];
const results = [];
for (const [name, before, after] of mutants) {
  assert.equal(source.split(before).length, 2, `Unique mutation: ${name}`);
  const mutant = source.replace(before, after);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '/app/tools/aggregate-audit/calculation.test.mjs'], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    env: { ...process.env, AUDIT_UNITS_SOURCE: `data:text/javascript;base64,${Buffer.from(mutant).toString('base64')}` }
  });
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0, `The suite must reject: ${name}`);
  assert.match(result.stdout, /AssertionError|ERR_ASSERTION/u, `Mutation must fail on behavior: ${name}`);
  results.push({ name, rejected: true, assertions: result.stdout.match(/^not ok .+$/gmu) || [] });
}
console.log(JSON.stringify({ rejected: results.length, total: mutants.length, results }, null, 2));
