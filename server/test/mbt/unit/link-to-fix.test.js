import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { coPlan } from '../../support/co-completion-fixture.mjs';
import { driverActivityOrderRefs } from '../../../src/driver-co-pickup-evidence.js';
import { operatorTransferPlanValueSql } from '../../../src/operator-linked-transfer-plan.js';

function pickup(members = ['SOM06531', 'SOM06537']) {
  const plan = coPlan({ members, extraTransfer: true });
  const co = plan.orders[0];
  plan.trucks[0].loads[0].stops[0].orderRefs = [co.id, 'TOB01106'];
  const record = { id: 4170, job_id: '330:T4:co-load:co-pick', plan_id: 330, plan_date: plan.planDate,
    load_id: 'co-load', stop_id: 'co-pick', stop_type: 'pickup', driver_login: 'co-driver', status: 'complete',
    order_refs: ['TOB01106', ...members], completed_at: '2039-09-18T16:54:00Z', job_details: { location: '150' },
    snapshot_orders: plan.orders, snapshot_trucks: plan.trucks };
  const correction = { co_ref: co.id, status: 'completed', received_at: '2039-09-18T18:27:00Z',
    completion_at: '2039-09-18T18:27:00Z', from_location: '150',
    proof: { coRef: co.id, sourceRefs: members, fromYard: '150', toYard: '2967',
      planId: 330, loadId: 'co-load', stopType: 'drop', coCreatedAt: '2039-09-17T12:00:00Z' } };
  return { record, correction, co };
}

test('L2 shared pickup keeps genuine TO cargo and uses immutable correction evidence for CO source members', () => {
  const { record, correction, co } = pickup();
  const before = structuredClone(record);
  assert.deepEqual(driverActivityOrderRefs(record, [correction]).sort(), [co.id, 'TOB01106'].sort());
  assert.deepEqual(record, before);
});

test('L2 a real source-SO pickup sharing the same visit remains customer-execution evidence', () => {
  const { record, correction } = pickup();
  const ref = correction.proof.sourceRefs[0];
  record.snapshot_orders.push({ id: ref, type: 'SO', sourceYard: '150', pickupLocations: ['150'], items: [{ quantity: 4 }] });
  const stops = record.snapshot_trucks[0].loads[0].stops;
  stops[0].orderRefs.push(ref);
  stops.push({ id: 'real-customer-drop', type: 'drop', orderId: ref, location: 'Customer' });
  assert.ok(driverActivityOrderRefs(record, [correction]).includes(ref));
});

test('L2 missing, ambiguous or chronologically invalid proof cannot exempt raw activity', () => {
  for (const kind of ['no-proof', 'duplicate', 'wrong-plan', 'wrong-load', 'wrong-phase', 'wrong-yard',
    'changed-members', 'extra-cargo', 'before-creation', 'after-completion', 'in-progress', 'missing-route']) {
    const { record, correction } = pickup();
    let corrections = [correction];
    const changes = {
      'no-proof': () => { corrections = []; }, 'duplicate': () => corrections.push(structuredClone(correction)),
      'wrong-plan': () => { correction.proof.planId = 999; }, 'wrong-load': () => { correction.proof.loadId = 'other'; },
      'wrong-phase': () => { record.stop_type = 'dropoff'; }, 'wrong-yard': () => { record.job_details.location = '3445'; },
      'changed-members': () => { correction.proof.sourceRefs = ['OTHER-SO']; }, 'extra-cargo': () => record.order_refs.push('UNEXPLAINED'),
      'before-creation': () => { record.completed_at = '2039-09-16T12:00:00Z'; },
      'after-completion': () => { record.completed_at = '2039-09-19T12:00:00Z'; },
      'in-progress': () => { record.status = 'in_progress'; }, 'missing-route': () => { record.snapshot_trucks = null; }
    };
    changes[kind]();
    assert.deepEqual(driverActivityOrderRefs(record, corrections), record.order_refs, kind);
  }
});

test('L2 generated member/reference permutations preserve all unrelated pickup cargo', () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 99999 }), { minLength: 1, maxLength: 8 }), fc.boolean(),
    (ids, reverse) => {
      const f = pickup(ids.map(id => `SO-PROPERTY-${id}`));
      if (reverse) {f.record.order_refs.reverse();}
      assert.deepEqual(driverActivityOrderRefs(f.record, [f.correction]).sort(), [f.co.id, 'TOB01106'].sort());
    }), { seed: 4170, numRuns: 100 });
});

test('L3 plan SQL rejects unsupported dynamic field names', () => {
  assert.throws(() => operatorTransferPlanValueSql('arbitrary_sql'), /Unsupported Operator plan field/);
});
