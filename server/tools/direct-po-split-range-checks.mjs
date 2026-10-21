import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { query, closeDb } from '../src/db.js';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const out = 'test-artifacts/direct-po-split-status-20261015';
const file = 'test/mbt/integration/direct-po-materialized-split-range.test.js';
const migration = 'migrations/291_direct_po_materialized_split_status.sql';
const sql = await readFile(migration, 'utf8');
async function run(label, args, expectedPass = true) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const log = (result.stdout || '') + (result.stderr || '');
  await writeFile(`${out}/${label}.log`, log);
  const count = key => Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0);
  const report = { label, status: result.status, tests: count('tests'), passed: count('pass'), failed: count('fail') };
  console.log(JSON.stringify(report));
  if (expectedPass) { assert.equal(result.status, 0); } else { assert.notEqual(result.status, 0); }
  return report;
}
try {
  await run('range-lint', ['node_modules/eslint/bin/eslint.js', '--config', 'eslint.mbt.config.js', '--max-warnings=0', file, 'tools/direct-po-split-range-checks.mjs']);
  const exact = "lower(btrim(child.detail->>'id'))=lower(btrim(allocation.sales_order_ref))";
  assert.equal(sql.split(exact).length, 2);
  await query(sql.replace(exact, 'false'));
  const mutant = await run('range-mutant', ['--test', '--test-concurrency=1', file], false);
  assert.equal(mutant.failed, 20, 'Every requested split must detect the missing exact match');
  await query(sql);
  const tests = await run('range-green', ['--test', '--test-concurrency=1', file]);
  assert.equal(tests.passed, 20);
  const hashes = {};
  for (const path of [file, migration, 'tools/direct-po-split-range-checks.mjs']) {
    hashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  await writeFile(`${out}/range-checks.json`, JSON.stringify({
    passed: true, suffixes: Array.from({ length: 20 }, (_, index) => `S${index + 1}`),
    transitions: ['Direct ship', 'In Transit', 'Completed'], tests, mutant, sourceHashes: hashes,
    entryPoint: 'bash server/tools/operator-to-yard-flow-test.sh node tools/direct-po-split-range-checks.mjs'
  }, null, 2) + '\n');
} finally {
  await query(sql);
  await closeDb();
}
