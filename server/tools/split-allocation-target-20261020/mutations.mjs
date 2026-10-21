import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
const out = 'test-artifacts/split-allocation-target-20261020';
const root = mkdtempSync('/tmp/split-quantity-mutants-');
const testFile = 'test/dispatch/integration/resplit-sibling-group-allocations.test.js';
const mutants = [
  { name: 'check-parent-instead-of-selected-child', file: 'src/dispatch-sales-resplit-repository.js',
    from: 'originalOrderId: row.split_ref, orderType: "SO"', to: 'originalOrderId: row.parent_order_ref, orderType: "SO"',
    tests: [testFile], property: true },
  { name: 'skip-selected-allocation-check', file: 'src/delivery-repository.js',
    from: 'if (type === "SO") await assertSalesOrderSplitUnallocated([String(originalOrderId).trim()]);',
    to: '// allocation check removed', tests: [testFile], property: true },
  { name: 'reuse-existing-split-suffix', file: 'src/delivery-repository.js',
    from: 'nextSuffix: maxSuffix + 1', to: 'nextSuffix: maxSuffix', tests: [testFile], property: true }
];
const results = [];
function run(name, tests, property = false) {
  const args = ['--test', '--test-concurrency=1', ...(property ? ['--test-name-pattern=^property:'] : []), ...tests];
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: 'utf8', timeout: 120000 });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(`${out}/mutations/${name}${property ? '-property' : ''}.log`, log);
  const fail = Number(log.match(/^# fail (\d+)$/m)?.[1] || 0);
  assert.equal(result.signal, null, name);
  assert.ok(!/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/u.test(log), name);
  return { exit: result.status, fail, killed: result.status !== 0 && fail > 0 };
}
try {
  mkdirSync(`${out}/mutations`, { recursive: true });
  for (const folder of ['src', 'public', 'test']) cpSync(folder, `${root}/${folder}`, { recursive: true });
  cpSync('package.json', `${root}/package.json`);
  symlinkSync(resolve('node_modules'), `${root}/node_modules`);
  const control = run('unmutated-control', [testFile]);
  assert.equal(control.exit, 0);
  for (const mutant of mutants) {
    const filename = `${root}/${mutant.file}`, original = readFileSync(filename, 'utf8');
    assert.equal(original.split(mutant.from).length, 2, `Mutation must have exactly one target: ${mutant.name}`);
    try {
      writeFileSync(filename, original.replace(mutant.from, mutant.to));
      const result = { name: mutant.name, ...run(mutant.name, mutant.tests) };
      if (mutant.property) result.propertyOnly = run(mutant.name, mutant.tests, true);
      results.push(result);
      writeFileSync(`${out}/mutations.json`, JSON.stringify(results, null, 2) + '\n');
      assert.ok(result.killed, mutant.name);
      if (mutant.property) assert.ok(result.propertyOnly.killed, `${mutant.name} property blind spot`);
    } finally { writeFileSync(filename, original); }
  }
  console.log(JSON.stringify(results));
} finally { rmSync(root, { recursive: true, force: true }); }
