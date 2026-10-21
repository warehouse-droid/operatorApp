import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export async function runMutations({ snapshot, tests, reset, out, primary }) {
  const policy = 'src/dispatch-source-notice-policy.js';
  const mutants = [
    { name: 'stored notices ignore current planning assignment', file: 'src/dispatch-executed-order-review-repository.js',
      from: 'notifyDispatcher: plannedRefs.has(key(row.order_ref)) && noticeChanges.length > 0',
      to: 'notifyDispatcher: noticeChanges.length > 0' },
    { name: 'dispatcher COs become NetSuite notices', file: policy,
      from: "if (!['SO', 'PO', 'TO'].includes(source.type))",
      to: "if (!['SO', 'PO', 'TO', 'CO'].includes(source.type))" },
    { name: 'local pickup overlays require confirmation', file: policy, property: true,
      from: "if (change.field === 'sourceYard') { return pickup || !source.transitCo && audited(change); }",
      to: "if (change.field === 'sourceYard') { return true; }" },
    { name: 'an unrelated receipt proves current cargo', file: policy, property: true,
      from: 'const cargo = received && receiptCargoMatches(source, payload);',
      to: 'const cargo = received;' }
  ];
  const results = [];
  for (const [index, mutant] of mutants.entries()) {
    const root = snapshot();
    try {
      const file = root + '/' + mutant.file, original = readFileSync(file, 'utf8');
      const changed = mutant.transform ? mutant.transform(original) : original.replace(mutant.from, mutant.to);
      assert.notEqual(changed, original, mutant.name + ' did not change the code');
      writeFileSync(file, changed);
      assert.equal(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status, 0, mutant.name + ' introduced syntax errors');
      reset();
      const result = tests('mutant-' + index, primary, { cwd: root });
      assert.ok(result.fail > 0 && result.exit !== 0, mutant.name + ' survived');
      assert.ok(!/SyntaxError:|ERR_MODULE_NOT_FOUND/u.test(result.log), mutant.name + ' failed on infrastructure');
      let property = null;
      if (mutant.property) {
        reset();
        const isolated = tests('mutant-property-' + index, primary, { cwd: root, pattern: 'property:' });
        property = { killed: isolated.fail > 0 && isolated.exit !== 0, failures: isolated.failures };
        assert.equal(property.killed, true, mutant.name + ' survived its property suite');
      }
      results.push({ name: mutant.name, file: mutant.file, killed: true, failures: result.failures, property });
      writeFileSync(out + '/mutations.json', JSON.stringify(results, null, 2) + '\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}
