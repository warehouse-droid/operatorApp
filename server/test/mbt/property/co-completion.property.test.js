import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { planJobsForDriver } from '../../../src/driver-repository.js';
import { coPlan } from '../../support/co-completion-fixture.mjs';

test('generated grouped transfers preserve the physical leg while ordinary groups expand', () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 999999 }), { minLength: 1, maxLength: 12 }), values => {
    const members = values.map(value => `SO${value}`);
    for (const groupedTransfers of [false, true]) {
      const plan = coPlan({ members, groupedTransfers });
      const original = structuredClone(plan);
      const job = planJobsForDriver(plan, 'co-driver').find(candidate => candidate.stopType === 'dropoff');
      assert.deepEqual(job.orderRefs, groupedTransfers ? members.map(ref => `CO-${ref}`) : ['CO-GOM-6531-6537']);
      assert.deepEqual(job.detailOrderRefs, job.orderRefs);
      assert.deepEqual(plan, original);
    }
    for (const type of ['SO', 'PO', 'TO']) {
      const plan = coPlan({ members });
      plan.orders[0] = { ...plan.orders[0], id: 'ORDINARY-GROUP', type, sourceTable: '',
        childOrderDetails: members.map(id => ({ id, type })) };
      for (const stop of plan.trucks[0].loads[0].stops) { stop.orderId = 'ORDINARY-GROUP'; }
      const job = planJobsForDriver(plan, 'co-driver').find(candidate => candidate.stopType === 'dropoff');
      assert.deepEqual(job.orderRefs, members);
    }
  }), { seed: 65316537, numRuns: 100 });
});
