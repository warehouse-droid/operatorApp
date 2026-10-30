import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpecialStockRequestService } from '../../../src/special-stock-request-service.js';

for (const priorSubmission of [false, true]) {
  test(`PO ${priorSubmission ? 'recovers a submitted native order' : 'creates an independent order before any submission'}`, async () => {
    const detail = { id: 62, revision: 8, vendorId: 331, customerId: 8444, salesOrderId: 101, salesOrderRef: 'TEST-SO-101',
      salesOrderApproved: true, operationalYardLocationId: 1, purchaseOrderSubmissionStartedAt: priorSubmission ? '2026-09-26T00:00:00Z' : null,
      salesOrderLines: [{ caseLineId: 1, remoteLineId: 9001, itemId: 2055, quantity: 500, uom: 'PC', rate: 17, description: 'Reviewed' }],
      vendorDiscountReview: { mode: priorSubmission ? undefined : 'per_line', amount: 0, lines: [{caseLineId:1,vendorDiscountPercent:0}] }, purchaseOrderLines: [{ caseLineId: 1, itemId: 2055, quantity: 500, uom: 'PC', unitPurchaseCost: 5, description: 'Reviewed' }] };
    const calls = [];
    const service = createSpecialStockRequestService({ assertPurchaseOrderReady: async () => {}, selectSalesRep: async () => ({ id: 123, name: 'TEST NetSuite Rep' }),
      getCase: async () => detail, claimOperation: async () => detail,
      resolveOrderUnits: async ls => ls.map(l => ({ ...l, unitId: 865 })), resolveLocations: async () => [{ netsuiteLocationId: 1 }],
      findMarkerOrders: async () => [],
      findLinkedPurchaseOrder: async input => { calls.push('native-recovery'); assert.equal(input.salesOrderId, 101); return { id: 202, entity_id: 331, location_id: 1, nativeLink: true }; },
      finalizeLinkedPurchaseOrder: async input => { calls.push('update'); assert.equal(input.purchaseOrderId, 202); assert.equal(input.payload.item.items[0].rate, 5); },
      createPurchaseOrder: async payload => { assert.equal(priorSubmission, false); calls.push('create'); assert.equal(payload.item.items[0].quantity, 500); return { id: 202 }; },
      markSubmitted: async () => { assert.equal(priorSubmission, false); calls.push('submit'); return detail; },
      fetchPurchaseOrderReference: async () => ({ tranid: 'PO202', status_text: 'Pending Receipt' }),
      recordPurchaseOrderCreation: async () => { calls.push('history'); }, linkPurchaseOrder: async () => { calls.push('link'); return detail; },
      failOperation: async () => { calls.push('failed'); }, sleep: async () => {}
    });
    await service.createPurchaseOrder(62, { expectedRevision: 8, operationId: '01911111-1111-7111-8111-111111111131' });
    assert.deepEqual(calls, priorSubmission ? ['native-recovery', 'update', 'history', 'link'] : ['submit', 'create', 'history', 'link']);
    assert.equal(detail.salesOrderLines[0].description, 'Reviewed');
  });
}
