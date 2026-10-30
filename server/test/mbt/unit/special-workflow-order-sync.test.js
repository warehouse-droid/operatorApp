import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpecialStockRequestService } from '../../../src/special-stock-request-service.js';

function harness({ syncFails = false } = {}) {
  const calls = [];
  const detail = { id: 42, revision: 8, vendorId: 9, customerId: 10, salesOrderId: 11,
    salesOrderApproved: true, operationalYardLocationId: 1, storeName: '3445',
    salesOrderLines: [{ caseLineId: 1, itemId: 2055, remoteLineId: 701, quantity: 10, uom: 'PC', description: 'Before' }],
    vendorDiscountReview: { mode: 'per_line', amount: 0, lines: [{caseLineId:1,vendorDiscountPercent:0}] }, purchaseOrderLines: [{ caseLineId: 1, itemId: 2055, quantity: 10, uom: 'PC', description: 'After', unitPurchaseCost: 2 }] };
  const service = createSpecialStockRequestService({ assertPurchaseOrderReady: async () => {}, selectSalesRep: async () => ({ id: 123, name: 'TEST NetSuite Rep' }),
    findLinkedPurchaseOrder: async () => null,
    getCase: async () => detail,
    markSubmitted: async () => detail,
    claimOperation: async () => detail,
    resolveLocations: async () => [{ netsuiteLocationId: 1 }],
    findMarkerOrders: async () => [],
    fetchSalesOrderReference: async () => ({ tranid: 'TEST-SO', status_text: 'Pending Fulfillment' }),
    synchronizeSalesDescriptions: async input => {
      calls.push(['sync', input]);
      if (syncFails) throw new Error('Description update failed');
    },
    recordDescriptionSync: async () => { calls.push(['record-sync']); return detail; },
    resolveOrderUnits: async lines => lines.map(line => ({ ...line, unitId: 1 })),
    createPurchaseOrder: async payload => { calls.push(['create-po', payload]); return { id: 12 }; },
    fetchPurchaseOrderReference: async () => ({ tranid: 'TEST-PO', status_text: 'Pending Receipt' }),
    recordPurchaseOrderCreation: async () => {},
    linkPurchaseOrder: async () => detail,
    failOperation: async () => calls.push(['failed']),
    sleep: async () => {}, config: { subsidiaryId: 2 }
  });
  return { service, calls, detail };
}
for (const syncFails of [false, true]) {test(`independent PO creation leaves SO descriptions unchanged even when the legacy writer ${syncFails ? 'would fail' : 'is available'}`, async () => {
  const { service, calls, detail } = harness({ syncFails });
  const before = structuredClone(detail.salesOrderLines);
  await service.createPurchaseOrder(42, { expectedRevision: 8, operationId: '01911111-1111-7111-8111-111111111115' });
  assert.deepEqual(calls.map(call => call[0]), ['create-po']);
  assert.equal(calls[0][1].item.items[0].description, 'After');
  assert.equal(calls[0][1].item.items[0].quantity, 10);
  assert.equal(calls[0][1].item.items[0].rate, 2);
  assert.deepEqual(detail.salesOrderLines, before);
});}
