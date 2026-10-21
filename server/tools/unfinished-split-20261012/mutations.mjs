import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export async function runMutations({ snapshot, tests, reset, out, primary }) {
  const repo = 'src/dispatch-sales-resplit-repository.js';
  const mutants = [
    { name: 'quantity conservation removed', file: repo, from: '  assertConserved(source, children);', to: '', property: true },
    { name: 'nested rather than root split references', file: repo, from: 'id: `${parent}-S${nextSuffix + index}`', to: 'id: `${source.id}-S${nextSuffix + index}`', property: true },
    { name: 'numbering ignores known sibling suffixes', file: repo, from: 'buildSalesResplits(source, input.parts ?? [], seed.nextSuffix)', to: 'buildSalesResplits(source, input.parts ?? [], 1)', property: true },
    { name: 'completed sibling retired together with source', file: repo,
      from: 'await deactivateDispatchGlobalOrderDefinitions([row.split_ref]);',
      to: 'await deactivateDispatchGlobalOrderDefinitions([row.split_ref, row.parent_order_ref + "-S1"]);', property: true },
    { name: 'exact retry fails rather than returning its original replacement', file: repo,
      from: 'if (previous?.requestHash === requestHash)', to: 'if (false)' },
    { name: 'operator packing lock bypassed', file: repo,
      from: 'if (header) { await lockConsolidatedLoadOrders([header.netsuite_id]); }', to: '' }
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
