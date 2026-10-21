import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test, { after } from 'node:test';
import { parse } from 'espree';
import fc from 'fast-check';
import { normalDispatchGroupTargets } from '../../../src/order-dependency-repository.js';
import { closeDb } from '../../../src/db.js';
import { dispatchDependencyOrderRefs } from '../../../src/yard-dependency-structure.js';

after(closeDb);
const source = readFileSync('src/server.js', 'utf8');
const names = new Set(['dispatchOrderStructureState', 'changedDispatchOrderStructureRefs',
  'safeNormalDependencyGroupingRefs', 'safeNormalDependencyGroupingTargets',
  'safeEstablishedDependencyUngroupingTargets', 'assertNoConsolidationStructureConflict',
  'dispatchOrderStructureComparisonPlan']);
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });
const functions = ast.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
  .filter(node => node?.type === 'FunctionDeclaration' && names.has(node.id.name));

function validator(canonicalOrders = []) {
  const checks = [];
  let reads = 0;
  // Database authority and external claims are boundaries; all structure logic
  // below is extracted unchanged from the real save-route implementation.
  const context = vm.createContext({ normalDispatchGroupTargets, dispatchDependencyOrderRefs,
    query: async () => { reads += 1; return { rows: canonicalOrders.map(full_order => ({ full_order })) }; },
    assertNoActiveConsolidationClaimsByRefs: async () => {},
    assertNoActiveOrderDependenciesByRefs: async refs => { checks.push([...refs]); }
  });
  vm.runInContext(functions.map(node => source.slice(...node.range)).join('\n'), context);
  return { run: (before, afterPlan) => context.assertNoConsolidationStructureConflict(before, afterPlan),
    checks, reads: () => reads };
}

function group(ids) {
  return { id: 'GOA-9611-9612', type: 'SO', childOrders: ids,
    childOrderDetails: ids.map(id => ({ id, type: 'SO' })) };
}

test('properties: unchanged persisted group placement is not a structure edit; real edits still are', async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 1, max: 10000 }), { minLength: 2, maxLength: 12 }),
    fc.boolean(), async (numbers, reverse) => {
      const ids = numbers.map(n => `SOA${String(n).padStart(5, '0')}`);
      const canonical = group(ids);
      const incoming = group(reverse ? [...ids].reverse() : ids);
      incoming.customer = 'Updated customer metadata';
      const before = { orders: [{ id: 'SO-UNRELATED', type: 'SO' }] };
      const v = validator([canonical]);
      await v.run(before, { orders: [incoming] });
      assert.deepEqual(v.checks, [], 'An unchanged global group must not be treated as a new grouping');
      assert.equal(v.reads(), 1);
      const changed = validator([canonical]);
      await changed.run(before, { orders: [group(ids.slice(0, -1))] });
      assert.equal(changed.checks.length, 1, 'Removing a linked group member must still run the lock');
      assert.ok(ids.every(id => changed.checks[0].includes(id)));
      assert.ok(changed.checks[0].includes(canonical.id));
      const snapshot = validator([group(ids.slice(0, -1))]);
      await snapshot.run({ orders: [canonical] }, { orders: [group(ids.slice(0, -1))] });
      assert.equal(snapshot.reads(), 0);
      assert.equal(snapshot.checks.length, 1);
      assert.ok(ids.every(id => snapshot.checks[0].includes(id)));
      const missing = validator();
      await missing.run(before, { orders: [incoming] });
      assert.equal(missing.checks.length, 1, 'Unproven groups must still run the structure lock');
      assert.ok(ids.every(id => missing.checks[0].includes(id)));
    }), { seed: 96119612, numRuns: 100 });
});

test('an existing snapshot group remains the comparison authority', async () => {
  const original = group(['SOA09611', 'SOA09612']);
  const incoming = group(['SOA09611']);
  const v = validator([incoming]);
  await v.run({ orders: [original] }, { orders: [incoming] });
  assert.equal(v.reads(), 0);
  assert.equal(v.checks.length, 1);
  assert.ok(v.checks[0].includes('SOA09612'));
});

test('ordinary orders and linked TO grouping receive no global SO exception', async () => {
  const v = validator();
  await v.run({ orders: [] }, { orders: [{ id: 'TOB01180', type: 'TO', childOrders: ['TOB01179'] }] });
  assert.equal(v.reads(), 0);
  assert.equal(v.checks.length, 1);
  const normal = validator();
  await normal.run({ orders: [] }, { orders: [{ id: 'SOA09611', type: 'SO' }] });
  assert.equal(normal.reads(), 0);
  assert.deepEqual(normal.checks, []);
});

test('properties: informational CO children never change the source delivery group membership', async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (coFirst, legacy) => {
    const sourceGroup = group(['SOA09611', 'SOA09612']);
    const co = { ...sourceGroup, id: 'CO-GOA-9611-9612', type: legacy ? undefined : 'CO',
      originalOrderId: 'SOA09611', sourceYard: '2967', destinationYard: '3445' };
    const before = { orders: [sourceGroup] };
    const afterPlan = { orders: coFirst ? [co, sourceGroup] : [sourceGroup, co] };
    const v = validator([sourceGroup]);
    await v.run(before, afterPlan);
    assert.deepEqual(v.checks, [], 'CO cargo must not regroup its source sales orders');
    const removed = validator([sourceGroup]);
    await removed.run(afterPlan, before);
    assert.deepEqual(removed.checks, [], 'Removing an informational CO must not ungroup its source');
  }), { seed: 96119613, numRuns: 40 });
});

test('real CO group member changes still run structure validation without SO cargo aliases', async () => {
  const co = { id: 'CO-GOA-9611-9612', type: 'CO', childOrders: ['CO-SOA09611', 'CO-SOA09612'],
    childOrderDetails: [{ id: 'CO-SOA09611', originalOrderId: 'SOA09611' },
      { id: 'CO-SOA09612', originalOrderId: 'SOA09612' }] };
  const v = validator();
  await v.run({ orders: [co] }, { orders: [{ ...co, childOrders: ['CO-SOA09611'],
    childOrderDetails: co.childOrderDetails.slice(0, 1) }] });
  assert.equal(v.checks.length, 1);
  assert.ok(v.checks[0].includes('CO-SOA09612'));
  assert.equal(v.checks[0].includes('SOA09611'), false);
  assert.equal(v.checks[0].includes('SOA09612'), false);
});
