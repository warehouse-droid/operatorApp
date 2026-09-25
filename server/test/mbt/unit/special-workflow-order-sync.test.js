import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpecialStockRequestService } from '../../../src/special-stock-request-service.js';

function harness({ syncFails = false } = {}) {
  const calls = [];
  const detail = { id: 42, revision: 8, vendorId: 9, customerId: 10, salesOrderId: 11,
    salesOrderApproved: true, operationalYardLocationId: 1, storeName: '3445',
    salesOrderLines: [{ caseLineId: 1, itemId: 2055, remoteLineId: 701, quantity: 10, uom: 'PC', description: 'Before' }],
    purchaseOrderLines: [{ caseLineId: 1, itemId: 2055, quantity: 10, uom: 'PC', description: 'After', unitPurchaseCost: 2 }] };
  const service = createSpecialStockRequestService({
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
  return { service, calls };
}
test('SCM descriptions synchronize the exact SO line before PO creation', async () => {
  const { service, calls } = harness();
  await service.createPurchaseOrder(42, { expectedRevision: 8, operationId: '01911111-1111-7111-8111-111111111115' });
  assert.deepEqual(calls.map(call => call[0]), ['sync', 'record-sync', 'create-po']);
  assert.equal(calls[0][1].changes[0].remoteLineId, 701);
  assert.equal(calls[0][1].changes[0].description, 'After');
});
test('failed SO description synchronization blocks PO creation', async () => {
  const { service, calls } = harness({ syncFails: true });
  await assert.rejects(() => service.createPurchaseOrder(42, { expectedRevision: 8, operationId: '01911111-1111-7111-8111-111111111116' }), /Description update failed/);
  assert.equal(calls.some(call => call[0] === 'create-po'), false);
});
