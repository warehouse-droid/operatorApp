import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export async function runMutations({ snapshot, tests, reset, out, primary }) {
  const repo = 'src/operator-order-reopen-repository.js';
  const mutants = [
    { name: 'manager authorization removed', file: repo, from: '(!roles.has("admin") && !roles.has("yard_manager"))', to: 'false' },
    { name: 'loaded quantities retained', file: repo, from: '"loaded_qty=0"', to: '"loaded_qty=loaded_qty"', property: true },
    { name: 'packed piece quantities retained', file: repo, from: '"packed_piece_qty", ', to: '', property: true },
    { name: 'retained photo references lost', file: repo, from: 'const photos = await retainedPhotos(orders);', to: 'const photos = [];', property: true },
    { name: 'preview fingerprint ignored', file: repo, from: 'if (c.stateHash !== expected)', to: 'if (false)' },
    { name: 'exact retry falls through to reset', file: repo, from: 'return previous.result;', to: '' },
    { name: 'operator omitted from link message', file: 'src/scm-dependency-management-policy.js',
      transform: source => source.replace(/const actor = name \?[^\n]+;/u, 'const actor = "";'), property: true },
    { name: 'pickup packing bypasses shared lock', file: 'src/delivery-repository.js',
      from: 'return withConsolidatedLoadMutation(() => getDeliveryOrder(orderId, { includeNetSuiteClosed: true }), () => confirmCustomerPickupLineUnlocked(orderId, lineId, values, operatorId));',
      to: 'return confirmCustomerPickupLineUnlocked(orderId, lineId, values, operatorId);' },
    { name: 'Driver start bypasses reset lock', file: 'src/driver-repository.js', transform: source => {
      const start = source.indexOf('export async function startDriverJob(');
      const end = source.indexOf('async function startDriverJobUnlocked(', start);
      const body = source.slice(start, end).replace('await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);', '');
      return source.slice(0, start) + body + source.slice(end);
    } }
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
