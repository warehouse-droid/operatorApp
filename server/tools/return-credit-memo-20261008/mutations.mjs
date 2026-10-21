import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { run } from './check.mjs';
const out = 'test-artifacts/return-credit-memo-20261008';
const unit = 'test/mbt/unit/return-credit-memo.test.js';
const integration = 'test/mbt/integration/return-credit-memo.test.js';
const mutants = [
  { name: 'ignore-cm-gate', file: 'src/operator-netsuite-posting-policy.js',
    from: 'creditMemoFlag?.enabled === true', to: 'false', test: unit, pattern: 'generated', property: true },
  { name: 'zero-credit-rates', file: 'src/return-credit-memo.js',
    from: 'rate: line.rate', to: 'rate: 0', test: unit, pattern: 'generated', property: true },
  { name: 'ignore-readback-quantity', file: 'src/return-credit-memo.js',
    from: 'exact(line.quantity)', to: '"ignored"', test: unit, pattern: 'generated', property: true },
  { name: 'forget-uncertain-post', file: 'src/return-batch-ra-service.js',
    from: 'resetAttempt: problem.returnRaCreationRejected === true', to: 'resetAttempt: true',
    test: integration, pattern: 'lost CM response' },
  { name: 'double-reserve-observed-cm', file: 'src/return-repository.js',
    from: 'row.transaction_type === "credit_memo"', to: 'false', test: integration, pattern: 'Q1 direct CM' },
  { name: 'omit-history-type', file: 'src/history-repository.js',
    from: "              'netSuiteStage', CASE WHEN ra.batch_id IS NOT NULL OR r.workflow_version=2 THEN r.netsuite_stage END,\n",
    to: '', test: integration, pattern: 'U1 personal history' }
];
const root = mkdtempSync('/tmp/return-cm-mutants-');
const results = [];
try {
  for (const directory of ['src', 'public', 'test']) { cpSync(directory, root + '/' + directory, { recursive: true }); }
  for (const directory of ['node_modules', 'contracts', 'migrations', 'test-artifacts', 'tools']) {
    symlinkSync(resolve(directory), root + '/' + directory);
  }
  cpSync('package.json', root + '/package.json');
  for (const mutant of mutants) {
    const path = root + '/' + mutant.file;
    const original = readFileSync(path, 'utf8');
    assert.equal(original.split(mutant.from).length, 2, 'Mutant must have one precise target: ' + mutant.name);
    try {
      writeFileSync(path, original.replace(mutant.from, mutant.to));
      const result = run('mutant-' + mutant.name, ['--test', '--test-name-pattern=' + mutant.pattern, mutant.test], { cwd: root, accepted: [1] });
      assert.ok(result.fail > 0 && !/ERR_MODULE_NOT_FOUND|SyntaxError/.test(result.log), 'Mutation must fail a behavior assertion');
      results.push({ name: mutant.name, killed: true, propertySuiteAlone: Boolean(mutant.property) });
    } finally {
      writeFileSync(path, original);
      assert.equal(readFileSync(path, 'utf8'), original);
    }
  }
  run('mutation-restored', ['--test', unit, integration], { cwd: root });
} finally { rmSync(root, { recursive: true, force: true }); }
writeFileSync(out + '/mutations.json', JSON.stringify(results, null, 2));
