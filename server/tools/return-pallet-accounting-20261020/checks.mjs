import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { runNodeTestFilesIsolated } from '../../test/support/test-database-isolation.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
export const mode = process.env.PALLET_CHECK_MODE;
assert.ok(['baseline', 'red', 'final'].includes(mode));
export const out = `test-artifacts/return-pallet-accounting-20261020/${mode}`;
export const testFile = 'test/mbt/integration/return-pallet-accounting.test.js';
export const sourceFile = 'src/return-netsuite.js';
mkdirSync(out, { recursive: true });

export function run(label, args, { accepted = [0], env = {}, executable = process.execPath } = {}) {
  const path = resolve(out, `${label}.log`);
  const fd = openSync(path, 'w');
  let result;
  try {
    result = spawnSync(executable, args, {
      env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], timeout: 300000
    });
  } finally {
    closeSync(fd);
  }
  const log = readFileSync(path, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [
    key, [...log.matchAll(new RegExp(`^(?:#|ℹ) ${key} (\\d+)$`, 'gm'))]
      .reduce((sum, match) => sum + Number(match[1]), 0)
  ]));
  console.log(JSON.stringify({ label, exit: result.status, ...counts }));
  assert.ok(accepted.includes(result.status), `${label}: ${log.slice(-6500)}`);
  return { exit: result.status, ...counts, log };
}

const regressions = [
  'test/mbt/unit/return-credit-memo.test.js',
  'test/mbt/unit/return-batch-ra-domain.test.js',
  'test/mbt/unit/return-ra-workflow.test.js',
  'test/mbt/unit/return-ra-client.test.js',
  'test/mbt/unit/return-rest-units.test.js',
  'test/mbt/unit/return-stored-orderline.test.js',
  'test/mbt/unit/return-customer-projection-branches.test.js',
  'test/mbt/unit/operator-receiving-return.test.js',
  'test/mbt/unit/operator-netsuite-posting-policy.red.test.js',
  'test/mbt/integration/return-credit-memo.test.js',
  'test/mbt/integration/return-batch-ra.test.js',
  'test/mbt/integration/return-ra-workflow.test.js',
  'test/mbt/integration/return-failed-draft.test.js',
  'test/mbt/integration/return-stored-orderline.test.js',
  'test/mbt/integration/stock-return-draft-insert.test.js',
  'test/mbt/integration/return-pallet-balance-sync.test.js',
  'test/mbt/integration/operator-netsuite-posting-policy-repository.red.test.js'
];

async function regress() {
  // A reproducible shuffled order, with a fresh disposable database per file.
  const shuffled = [...regressions].sort((a, b) =>
    createHash('sha256').update(`800909:${a}`).digest('hex')
      .localeCompare(createHash('sha256').update(`800909:${b}`).digest('hex')));
  writeFileSync(`${out}/regression-files.json`, JSON.stringify(shuffled, null, 2));
  assert.equal(await runNodeTestFilesIsolated(shuffled.map(file => resolve(file)),
    { label: 'Pallet balance regression' }), 0);
  const harnesses = {};
  for (const harness of ['return-module', 'return-customer-directory', 'operator-return-ui', 'return-portal-ui']) {
    const result = run(harness, [`src/${harness}-harness.js`], { accepted: [0, 1] });
    harnesses[harness] = { exit: result.exit, failure: result.exit === 0 ? null
      : result.log.split('\n').filter(line =>
        /^(AssertionError|Error|  code:|  expected:|  operator:)/.test(line)).join('\n') };
    if (result.exit !== 0) {
      assert.ok(harnesses[harness].failure, 'A baseline failure needs an identifiable assertion');
    }
  }
  writeFileSync(`${out}/harnesses.json`, JSON.stringify(harnesses, null, 2));
  if (mode === 'final') {
    assert.deepEqual(harnesses, JSON.parse(readFileSync('/baseline/checks/harnesses.json', 'utf8')),
      'Existing harness failures must not change and no new failures are allowed');
  }
}

async function main() {
  const action = process.argv[2];
  if (action === 'regression') {
    await regress();
    return;
  }
  if (mode === 'red') {
    const red = run('red', ['--test', testFile], { accepted: [1] });
    assert.equal(red.fail, 4, 'P1–P4 must fail for behavior; P5/P6 are existing invariants');
    assert.doesNotMatch(red.log, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    writeFileSync(`${out}/red-result.json`, JSON.stringify({ ...red, log: undefined }, null, 2));
    return;
  }
  if (mode === 'baseline') {
    await regress();
    return;
  }
  const coverage = run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
    `--include=${sourceFile}`, '--reporter=json', '--reporter=json-summary',
    `--temp-directory=${out}/c8`, `--report-dir=${out}/coverage`,
    'node', '--test', testFile]);
  assert.equal(coverage.fail, 0);
  assert.equal(coverage.skipped, 0);
  run('static', ['tools/return-pallet-accounting-20261020/static.mjs']);
  await regress();
  run('mutations', ['tools/return-pallet-accounting-20261020/mutations.mjs']);
  const versions = Object.fromEntries(['pg', 'c8', 'eslint', 'typescript', 'fast-check'].map(name =>
    [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version]));
  const sourceHash = createHash('sha256').update(readFileSync(sourceFile)).digest('hex');
  writeFileSync(`${out}/results.json`, JSON.stringify({
    passed: true, sourceHash, versions, node: process.version,
    accountingTests: coverage.tests, generatedCases: 80, regressionFiles: regressions,
    dependencyLock: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex')
  }, null, 2));
}

if (process.argv[1]?.endsWith('/checks.mjs')) {
  await main();
}
