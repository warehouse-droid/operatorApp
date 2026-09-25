import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { aggregateYardsForActor, assertAggregateSubmitter } from '../../../src/aggregate-request-domain.js';

test('ordinary yard permissions grant no Aggregate access', () => {
  for (const role of ['operator', 'sales', 'yard_manager']) {
    const actor = { id: role, role, yardLocationIds: [1, 28], operatorYardLocationIds: [1, 15] };
    assert.deepEqual(aggregateYardsForActor(actor), [], role);
    assert.throws(() => assertAggregateSubmitter(actor), { status: 403 });
  }
});
test('dedicated Aggregate yards work independently of ordinary yards', () => {
  for (const role of ['operator', 'sales', 'yard_manager']) {
    const actor = { id: role, role, yardLocationIds: [15], operatorYardLocationIds: [26], aggregateRequestYardLocationIds: [1] };
    assert.deepEqual(aggregateYardsForActor(actor), [1]);
    assert.doesNotThrow(() => assertAggregateSubmitter(actor));
  }
});
test('SCM and Admin management do not automatically allow submission', () => {
  for (const role of ['scm', 'admin']) {
    const actor = { id: role, role };
    assert.deepEqual(aggregateYardsForActor(actor), [1, 28, 15, 26]);
    assert.throws(() => assertAggregateSubmitter(actor), { status: 403 });
  }
});
test('property: Aggregate yards equal the explicit grant and ignore ordinary yard changes', () => {
  fc.assert(fc.property(fc.constantFrom('operator', 'sales', 'yard_manager'),
    fc.subarray([1, 28, 15, 26]), fc.subarray([1, 28, 15, 26]), fc.subarray([1, 28, 15, 26]),
    (role, grants, salesYards, operatorYards) => {
      const actor = { id: role, role, aggregateRequestYardLocationIds: grants, yardLocationIds: salesYards, operatorYardLocationIds: operatorYards };
      assert.deepEqual(aggregateYardsForActor(actor), grants);
      if (grants.length) { assert.doesNotThrow(() => assertAggregateSubmitter(actor)); }
      else { assert.throws(() => assertAggregateSubmitter(actor), { status: 403 }); }
    }), { seed: 20260922, numRuns: 150 });
});
