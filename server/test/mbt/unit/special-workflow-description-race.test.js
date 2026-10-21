import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { matchSpecialOrderCoverage } from '../../../src/special-stock-request-domain.js';
import { createSpecialStockRequestService } from '../../../src/special-stock-request-service.js';

test('property: a reviewed description transition is bound to the exact special SO line', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1e6 }), fc.integer({ min: 1, max: 1000 }), (remoteLineId, quantity) => {
    const expected = [{ id: 11, itemId: 2055, itemName: 'MBBS-Special Order', description: 'Original', quantity, uom: 'PC', remoteLineId }];
    const actual = [{ id: 21, lineId: remoteLineId, itemId: 2055, description: `Reviewed ${remoteLineId}`, quantity, uom: 'PC' }];
    const reviewedDescriptionChanges = [{ expectedLineId: 11, remoteLineId, description: actual[0].description }];
    const options = { orderKind: 'Sales Order', reviewedDescriptionChanges };
    assert.deepEqual(matchSpecialOrderCoverage(expected, actual, options), [{ expectedLineId: 11, canonicalLineId: 21, remoteLineId }]);
    assert.throws(() => matchSpecialOrderCoverage(expected, actual), { code: 'SPECIAL_ORDER_COVERAGE_MISMATCH' });
    for (const patch of [{ quantity: quantity + 1 }, { uom: 'SQFT' }, { itemId: 1784 }, { lineId: remoteLineId + 1 }, { description: 'Unreviewed' }]) {
      assert.throws(() => matchSpecialOrderCoverage(expected, [{ ...actual[0], ...patch }], options), { code: 'SPECIAL_ORDER_COVERAGE_MISMATCH' });
    }
    for (const patch of [{ expectedLineId: 12 }, { remoteLineId: remoteLineId + 1 }, { description: '' }]) {
      assert.throws(() => matchSpecialOrderCoverage(expected, actual, { reviewedDescriptionChanges: [{ ...reviewedDescriptionChanges[0], ...patch }] }), { code: 'SPECIAL_ORDER_COVERAGE_MISMATCH' });
    }
    assert.throws(() => matchSpecialOrderCoverage([{ ...expected[0], itemId: 1784 }], [{ ...actual[0], itemId: 1784 }], options), { code: 'SPECIAL_ORDER_COVERAGE_MISMATCH' });
  }), { seed: 26092031, numRuns: 100 });
});

for (const kind of ['sales_order', 'purchase_order']) {
  test(`asynchronous ${kind} final-link errors release the creating state to attention`, async () => {
    const calls = [];
    const detail = { id: 62, revision: 5, customerId: 8444, vendorId: 331, operationalYardLocationId: 1,
      fulfillmentMethod: 'yard_pickup', salesOrderId: kind === 'purchase_order' ? 91 : null,
      salesOrderLines: [], vendorDiscountReview: { mode: 'per_line', amount: 0, lines: [] }, purchaseOrderLines: [] };
    const rejected = Object.assign(new Error('Finalization rejected'), { code: 'SPECIAL_REVISION_CONFLICT' });
    const service = createSpecialStockRequestService({ assertPurchaseOrderReady: async () => {}, selectSalesRep: async () => ({ id: 123, name: 'TEST NetSuite Rep' }),
      getCase: async () => detail, claimOperation: async () => detail,
      resolveLocations: async () => [{ netsuiteLocationId: 1 }],
      findMarkerOrders: async () => [{ id: 99, entity_id: kind === 'sales_order' ? 8444 : 331, location_id: 1 }],
      fetchSalesOrderReference: async () => ({ tranid: 'SO99', status_text: 'Pending Fulfillment' }),
      fetchPurchaseOrderReference: async () => ({ tranid: 'PO99', status_text: 'Pending Receipt' }),
      recordPurchaseOrderCreation: async () => {},
      linkSalesOrder: async () => { throw rejected; }, linkPurchaseOrder: async () => { throw rejected; },
      failOperation: async (id, input) => calls.push({ id, ...input }),
      createSalesOrder: async () => { throw Error('Duplicate SO POST'); },
      createPurchaseOrder: async () => { throw Error('Duplicate PO POST'); }
    });
    const operationId = '01911111-1111-7111-8111-111111111131';
    await assert.rejects(service[kind === 'sales_order' ? 'createSalesOrder' : 'createPurchaseOrder'](62, { expectedRevision: 5, operationId }), rejected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 62);
    assert.equal(calls[0].orderKind, kind);
    assert.equal(calls[0].operationId, operationId);
    assert.equal(calls[0].errorMessage, 'Finalization rejected');
  });
}
