import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { dispatchSourceRefreshBaseline } from '../../../src/dispatch-source-refresh.js';
import { digestDispatchPlan } from '../../../src/dispatch-planner-performance.js';
import { cargoFunctions } from '../../support/sales-order-cargo-fixture.mjs';

const { mergeDispatchSourceRefreshOrders } = cargoFunctions('../../public/dispatch.js', ['dispatchSourceValueEqual', 'mergeDispatchSourceRefreshOrders']);
function fixture(quantities) {
  const plan = { id: '1', planDate: '2026-10-23', status: 'confirmed', note: '', revision: 10,
    orders: [{ id: 'SO1', items: [{ quantity: quantities[0] }], notes: 'saved' }],
    trucks: [{ id: 'T1', loads: [{ id: 'L1', stops: [{ id: 'first', orderId: 'SO1' }, { id: 'second', orderId: 'SO1' }] }] }], summary: {} };
  const request = { baseRevision: plan.revision, baseDigest: digestDispatchPlan(plan) };
  const checkpoints = [];
  for (const quantity of quantities.slice(1)) {
    checkpoints.push({ ...structuredClone(plan), archive_reason: 'before_netsuite_source_acceptance' });
    plan.orders[0].items[0].quantity = quantity;
    plan.revision++;
  }
  return { plan, checkpoints, request };
}

test('source-only chains preserve local notes, ordering and inputs across 1000 generated drafts', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 10000 }), { minLength: 2, maxLength: 9 }), fc.string(), (quantities, note) => {
    const f = fixture(quantities);
    const frozen = JSON.stringify(f);
    const baseline = dispatchSourceRefreshBaseline(f.plan, f.checkpoints, f.request);
    assert.equal(baseline?.digest, f.request.baseDigest);
    const local = [{ ...structuredClone(baseline.orders[0]), notes: note }, { id: 'LOCAL', notes: note }];
    const original = JSON.stringify(local);
    const merged = mergeDispatchSourceRefreshOrders(local, baseline.orders, f.plan.orders);
    assert.equal(merged[0].items[0].quantity, quantities.at(-1));
    assert.equal(merged[0].notes, note);
    assert.equal(merged[1], local[1]);
    assert.deepEqual(mergeDispatchSourceRefreshOrders(merged, baseline.orders, f.plan.orders), merged, 'refresh is idempotent');
    assert.equal(JSON.stringify(local), original);
    assert.equal(JSON.stringify(f), frozen);
  }), { numRuns: 1000, seed: 221037 });
});

test('missing, unrelated and tampered history never authorizes a source recovery', () => {
  const attacks = [
    f => { f.request.baseDigest = 'wrong'; }, f => { f.checkpoints.pop(); },
    f => { f.checkpoints[0].archive_reason = 'before_incremental_command'; },
    f => { f.checkpoints[0].revision++; },
    f => { f.plan.trucks[0].loads[0].stops.reverse(); }, f => { f.plan.summary.other = true; },
    f => { f.plan.status = 'draft'; }, f => { f.plan.note = 'changed'; },
    f => { f.plan.orders[0].notes = 'remote edit'; }, f => { f.plan.orders[0].id = 'OTHER'; },
    f => { f.request.baseRevision = -1; }, f => { f.request.baseRevision = 10.5; },
    f => { f.request.baseRevision = ''; }, f => { f.plan.revision = 111; }
  ];
  fc.assert(fc.property(fc.integer({ min: 0, max: 9999 }), value => {
    for (const attack of attacks) {
      const f = fixture([value, value + 1]);
      attack(f);
      assert.equal(dispatchSourceRefreshBaseline(f.plan, f.checkpoints, f.request), null);
    }
  }), { numRuns: 100, seed: 221038 });
});

test('overlapping quantities reject atomically while missing local orders stay removed', () => {
  const before = [{ id: 'A', items: [{ quantity: 1 }] }, { id: 'B', items: [{ quantity: 1 }] }];
  const after = [{ id: 'A', items: [{ quantity: 2 }] }, { id: 'B', items: [{ quantity: 2 }] }];
  assert.equal(mergeDispatchSourceRefreshOrders([{ id: 'A', items: [{ quantity: 1 }] }, { id: 'B', items: [{ quantity: 3 }] }], before, after), null);
  assert.deepEqual(mergeDispatchSourceRefreshOrders([before[0]], before, after), [after[0]]);
  const localGroup = [{ id: 'G', childOrderDetails: [{ ...before[0], notes: 'my note' }, before[1]] }];
  const merged = mergeDispatchSourceRefreshOrders(localGroup, [{ id: 'G', childOrderDetails: before }], [{ id: 'G', childOrderDetails: after }]);
  assert.equal(merged[0].childOrderDetails[0].notes, 'my note');
  assert.equal(merged[0].childOrderDetails[0].items[0].quantity, 2);
  assert.equal(mergeDispatchSourceRefreshOrders([{ id: 'G', childOrderDetails: [{ id: 'A', items: [{ quantity: 3 }] }] }],
    [{ id: 'G', childOrderDetails: before }], [{ id: 'G', childOrderDetails: after }]), null);
  assert.deepEqual(mergeDispatchSourceRefreshOrders([{ id: 'A', pallets: 2, notes: 'draft' }], [{ id: 'A', pallets: 2 }], [{ id: 'A' }]), [{ id: 'A', notes: 'draft' }]);
});
