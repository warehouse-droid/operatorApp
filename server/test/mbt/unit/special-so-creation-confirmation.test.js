/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { createSpecialStockRequestService } from '../../../src/special-stock-request-service.js';

function fixture({ submitted = true, rows = [{ id: 1052318, entity_id: 9875, location_id: 28 }], reference = { id: 1052318, tranid: 'TEST-SOB', status_text: 'Pending Fulfillment' }, path = 'standalone' } = {}) {
  const detail = { id: 162, revision: 19, customerId: 3051, netsuiteCustomerId: 3051,
    operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', estimateId: 22,
    salesOrderSubmissionStartedAt: submitted ? '2026-10-09T21:42:56.149Z' : null,
    salesOrderLines: [{ itemId: 2055, quantity: 1450.65, uom: 'SQFT', rate: 7.28,
      description: 'Saved draft', nativeDiscountPercent: 10, palletQty: 6 }], salesDiscountMode: 'total' };
  const calls = [];
  const unexpected = async () => { assert.fail('Content verification or duplicate submission ran'); };
  const deps = {
    getCase: async () => structuredClone(detail), claimOperation: async () => structuredClone(detail),
    selectSalesRep: async () => ({ id: 123, name: 'TEST Rep' }),
    findMarkerOrders: async input => { calls.push(['markers', input]); return rows; },
    fetchSalesOrderReference: async id => { calls.push(['reference', id]); return reference; },
    linkSalesOrder: async (_id, input) => { calls.push(['link', input]); return input; },
    verifyDiscountSalesOrder: unexpected, failOperation: async (_id, input) => calls.push(['failure', input]),
    sleep: async () => {}, config: { subsidiaryId: 1, pickupMethodId: 2 },
    resolveLocations: submitted ? unexpected : async () => [{ netsuiteLocationId: 1 }],
    resolveOrderUnits: submitted ? unexpected : async lines => lines.map(line => ({ ...line, unitId: 866 })),
    assertDiscountReady: async () => {},
    markSubmitted: submitted ? unexpected : async () => detail,
    createSalesOrder: submitted ? unexpected : async () => { calls.push(['post', path]); return { id: 1052318 }; },
    createDiscountSalesOrder: submitted ? unexpected : async () => { calls.push(['post', path]); return { id: 1052318 }; },
    transformEstimate: submitted ? unexpected : async () => { calls.push(['post', path]); return { id: 1052318 }; }
  };
  return { calls, detail, deps, service: createSpecialStockRequestService(deps) };
}
const input = { expectedRevision: 19, operationId: 'b505a587-f2ff-4b4d-984a-d2f7ce77843e' };

test('already submitted SO recovers its number despite changed content and unavailable draft lookups', async () => {
  const f = fixture();
  const linked = await f.service.createSalesOrder(162, input);
  assert.equal(linked.salesOrderId, 1052318);
  assert.equal(linked.salesOrderRef, 'TEST-SOB');
  assert.equal(linked.verifiedRemote, true);
  assert.equal(f.calls.find(([kind]) => kind === 'markers')[1].entityId, null);
  assert.deepEqual(f.calls.map(([kind]) => kind), ['markers', 'reference', 'link']);
});

for (const path of ['standalone', 'estimate_transform', 'discounted']) {
  test(`${path} successful creation links the number without reading or verifying order content`, async () => {
    const f = fixture({ submitted: false, rows: [], path });
    if (path !== 'discounted') {
      delete f.detail.salesOrderLines[0].nativeDiscountPercent;
    }
    const result = await f.service.createSalesOrder(162, { ...input, source: path });
    assert.equal(result.salesOrderRef, 'TEST-SOB');
    assert.equal(f.calls.filter(([kind]) => kind === 'post').length, 1);
    assert.deepEqual(f.calls.map(([kind]) => kind), ['markers', 'post', 'reference', 'link']);
  });
}

test('missing or ambiguous SO identity never links or resubmits a started operation', async () => {
  for (const [options, code] of [
    [{ rows: [] }, 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN'],
    [{ rows: [{ id: 1 }, { id: 2 }] }, 'SPECIAL_REMOTE_MARKER_DUPLICATE'],
    [{ rows: [{ id: 0 }] }, 'SPECIAL_REMOTE_MARKER_INVALID'],
    [{ reference: null }, 'SPECIAL_REMOTE_HYDRATION_FAILED'],
    [{ reference: { id: 1052318, tranid: '' } }, 'SPECIAL_REMOTE_HYDRATION_FAILED']
  ]) {
    const f = fixture(options);
    // Identity failure is the subject of this test; allow yard lookup on the old implementation.
    f.deps.resolveLocations = async () => [{ netsuiteLocationId: 1 }];
    f.service = createSpecialStockRequestService(f.deps);
    await assert.rejects(f.service.createSalesOrder(162, input), { code });
    assert.equal(f.calls.some(([kind]) => kind === 'link' || kind === 'post'), false);
  }
});

test('property: every uniquely identified existing SO links with arbitrary customer and yard edits', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10000000 }), fc.integer({ min: 1, max: 100000 }),
    fc.integer({ min: 1, max: 1000 }), async (id, entity, location) => {
      const f = fixture({ rows: [{ id, entity_id: entity, location_id: location }], reference: { id, tranid: `TEST-SO-${id}` } });
      const linked = await f.service.createSalesOrder(162, input);
      assert.equal(linked.salesOrderId, id);
      assert.equal(linked.salesOrderRef, `TEST-SO-${id}`);
      assert.deepEqual(f.calls.map(([kind]) => kind), ['markers', 'reference', 'link']);
      for (const [options, code] of [
        [{ rows: [{ id }, { id: id + 1 }] }, 'SPECIAL_REMOTE_MARKER_DUPLICATE'],
        [{ rows: [], deps: { resolveLocations: async () => [{ netsuiteLocationId: 1 }] } }, 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN'],
        [{ rows: [{ id }], reference: { id, tranid: '' } }, 'SPECIAL_REMOTE_HYDRATION_FAILED']
      ]) {
        const blocked = fixture(options);
        Object.assign(blocked.deps, options.deps || {});
        blocked.service = createSpecialStockRequestService(blocked.deps);
        await assert.rejects(blocked.service.createSalesOrder(162, input), { code });
        assert.equal(blocked.calls.some(([kind]) => kind === 'link' || kind === 'post'), false);
      }
    }), { seed: 122477, numRuns: 100 });
});
