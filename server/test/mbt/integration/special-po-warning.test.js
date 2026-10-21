import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { createSpecialQuantityService } from '../../../src/special-stock-quantity-service.js';
import { createSpecialStockRequestService } from '../../../src/special-stock-request-service.js';
import * as repo from '../../../src/special-stock-request-repository.js';

after(closeDb);
const context = { operatorId: 'so-creation-confirmation-test', authorizedStoreLocationIds: [1] };
async function fixture(run) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('so-creation-confirmation-test','so-creation-confirmation-test','TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING");
      await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8877477,'TEST-CONFIRM','TEST Confirm','TEST Confirm','CAD',true,now(),'test',repeat('e',64)) ON CONFLICT DO NOTHING");
      await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
      let detail = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01',
        customerId: 8877477, customerName: 'TEST Confirm', vendorId: 8877478, vendorName: 'TEST Vendor',
        fulfillmentMethod: 'yard_pickup', lines: [{ productName: 'TEST Material', quantity: 10,
          uom: 'PCS', rate: 5, requiredDate: '2099-02-01' }] }, context);
      detail = await repo.respondSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision,
        supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 8877478,
        vendorName: 'TEST Vendor', vendorYard: 'TEST Yard' }, context);
      detail = await repo.decideSpecialStockLine(detail.id, detail.lines[0].id,
        { expectedRevision: detail.revision, decision: 'accepted' }, context);
      detail = await repo.saveSpecialSalesOrderDraft(detail.id, { expectedRevision: detail.revision,
        customerId: 8877477, operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', palletTotal: 0,
        materialLines: [{ caseLineId: detail.lines[0].id, itemId: 2055, description: 'TEST Material',
          quantity: 10, packageQuantity: 10, conversionToPc: 1, uom: 'PC', rate: 5 }] }, context);
      await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,status,status_text,netsuite_active) VALUES(8877480,'TEST-SO-CONFIRMED',999,28,'B','Pending Fulfillment',true)");
      await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES(8877480,88774801,2055,'MBBS-Special Order','Edited in NetSuite',20,'SQFT',true)");
      await run(detail);
    });
  } finally { await rollback.rollback(); }
}
const link = detail => repo.linkSpecialSalesOrder(detail.id, { expectedRevision: detail.revision,
  salesOrderId: 8877480, salesOrderRef: 'TEST-SO-CONFIRMED', source: 'standalone', verifiedRemote: true,
  salesOrderStatus: 'Pending Fulfillment', salesOrderApproved: true }, context);

async function adjust(detail, quantity = 20) {
  let d = await link(detail);
  d = await repo.requestSpecialQuantityChange(d.id, { expectedRevision: d.revision,
    lines: [{ caseLineId: d.lines[0].id, quantity, uom: 'SQFT', productName: 'Edited material' }] }, context);
  const service = createSpecialQuantityService({ withReviewLock: (_id, run) => run(),
    preparePlan: async () => assert.fail('Local adjustment must not prepare a remote write'),
    applyPlan: async () => assert.fail('Local adjustment must not write orders') });
  return service.reviewQuantityChange(d.id, { expectedRevision: d.revision,
    reviewId: d.quantityReview.id, decision: 'approve' }, context);
}

async function prepare(d) {
  return repo.prepareSpecialPurchaseOrder(d.id, { expectedRevision: d.revision, pallet: { quantity: 0 },
    lines: [{ caseLineId: d.lines[0].id, description: 'Edited material', quantity: d.lines[0].packageQuantity,
      uom: 'SQFT', unitPurchaseCost: 2, vendorDiscountPercent: 0 }] }, context);
}

const claim = d => repo.claimSpecialOrderOperation(d.id, { expectedRevision: d.revision,
  orderKind: 'purchase_order', operationId: randomUUID() }, context);

async function salesSnapshot(id) {
  return (await query(`SELECT json_build_object(
    'order',(SELECT row_to_json(s) FROM sales_orders s WHERE netsuite_id=8877480),
    'lines',(SELECT json_agg(l ORDER BY id) FROM sales_order_lines l WHERE sales_order_id=8877480),
    'saved',(SELECT json_agg(d ORDER BY id) FROM sales_special_stock_order_lines d WHERE request_id=$1 AND order_kind='sales_order')) AS snapshot`, [id])).rows[0].snapshot;
}

function purchaseService(calls, overrides = {}) {
  return createSpecialStockRequestService({
    findMarkerOrders: async input => { calls.markers.push(input); return []; },
    findLinkedPurchaseOrder: async () => assert.fail('Local correction must not resolve native SO line linkage'),
    finalizeLinkedPurchaseOrder: async () => assert.fail('Local correction must not change native SO linkage'),
    synchronizeSalesDescriptions: async () => assert.fail('Issued SO must remain unchanged'),
    recordDescriptionSync: async () => assert.fail('Historical SO snapshot must remain unchanged'),
    resolveLocations: async () => [{ netsuiteLocationId: 1, subsidiaryId: 1 }],
    resolveOrderUnits: async lines => lines.map(line => ({ ...line, unitId: 1 })),
    createPurchaseOrder: async payload => {
      calls.created.push(payload);
      await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES(8877481,'TEST-PO-CORRECTED',8877478,1,'Pending Receipt',true)");
      await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES(8877481,88774811,2055,'MBBS-Special Order',$1,$2,'SQFT',true)",
        [payload.item.items[0].description, payload.item.items[0].quantity]);
      return { id: 8877481 };
    },
    fetchPurchaseOrderReference: async () => ({ tranid: 'TEST-PO-CORRECTED', status_text: 'Pending Receipt' }),
    recordPurchaseOrderCreation: async () => {}, sleep: async () => {}, ...overrides
  });
}

test('approved local correction creates a PO from the current review without rewriting the SO', () => fixture(async detail => {
  const before = await salesSnapshot(detail.id);
  const d = await prepare(await adjust(detail));
  await query("UPDATE sales_special_stock_cases SET attention=true,attention_reason='Sales Order does not contain the exact reviewed item, quantity, UOM, and description for MBBS-Special Order.' WHERE request_id=$1", [d.id]);
  const calls = { markers: [], created: [] };
  const saved = await purchaseService(calls).createPurchaseOrder(d.id, { expectedRevision: d.revision, operationId: randomUUID() }, context);
  assert.equal(saved.purchaseOrderId, 8877481);
  assert.equal(saved.purchaseOrderOperationStatus, 'linked');
  assert.equal(saved.attention, false);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].item.items[0].quantity, 20);
  assert.equal(calls.created[0].item.items[0].description, 'Edited material');
  assert.ok(calls.markers.every(input => input.salesOrderId === null));
  assert.deepEqual(await salesSnapshot(d.id), before);
  assert.equal((await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: 8877480 })).attention, false);
  assert.deepEqual(await salesSnapshot(d.id), before);
  await assert.rejects(purchaseService(calls).createPurchaseOrder(d.id,
    { expectedRevision: (await repo.getSpecialStockCase(d.id)).revision, operationId: randomUUID() }, context), { code: 'SPECIAL_PO_ALREADY_LINKED' });
  assert.equal(calls.created.length, 1);
  await query('UPDATE purchase_order_lines SET quantity=999 WHERE purchase_order_id=8877481');
  assert.equal((await repo.reconcileSpecialOrderWebhook({ orderKind: 'purchase_order', orderId: 8877481 })).attention, true,
    'An unreviewed issued PO change still requires attention');
}));

test('SO reconciliation cannot recreate a warning lock during locally adjusted PO creation', () => fixture(async detail => {
  const d = await claim(await prepare(await adjust(detail)));
  const result = await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: 8877480 });
  assert.equal(result.attention, false);
  const saved = await repo.getSpecialStockCase(d.id);
  assert.equal(saved.purchaseOrderOperationStatus, 'creating');
  assert.equal(saved.purchaseOrderOperationId, d.purchaseOrderOperationId);
  assert.equal(saved.salesOrderLines[0].quantity, 10);
  await assert.rejects(claim(saved), { code: 'SPECIAL_REMOTE_OPERATION_BUSY' });
}));

test('a locally adjusted PO with an uncertain submission is recovered without resubmission', () => fixture(async detail => {
  let d = await claim(await prepare(await adjust(detail)));
  d = await repo.markSpecialOrderSubmitted(d.id, { expectedRevision: d.revision,
    orderKind: 'purchase_order', operationId: d.purchaseOrderOperationId }, context);
  d = await repo.failSpecialOrderOperation(d.id, { orderKind: 'purchase_order', operationId: d.purchaseOrderOperationId,
    retryable: true, errorMessage: 'Timeout after submission', errorCode: 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN' }, context);
  const calls = { markers: [], created: [] };
  await assert.rejects(purchaseService(calls).createPurchaseOrder(d.id,
    { expectedRevision: d.revision, operationId: d.purchaseOrderOperationId }, context), { code: 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN' });
  const saved = await repo.getSpecialStockCase(d.id);
  assert.equal(saved.purchaseOrderOperationStatus, 'attention');
  assert.ok(saved.purchaseOrderSubmissionStartedAt);
  assert.equal(calls.created.length, 0);
}));

test('unadjusted SO mismatches and pending adjustments still prevent PO creation', () => fixture(async detail => {
  let d = await prepare(await link(detail));
  await assert.rejects(claim(d), { code: 'SPECIAL_ORDER_COVERAGE_MISMATCH' });
  d = await repo.requestSpecialQuantityChange(d.id, { expectedRevision: d.revision,
    lines: [{ caseLineId: d.lines[0].id, quantity: 20 }] }, context);
  await assert.rejects(claim(d), { code: 'SPECIAL_QUANTITY_REVIEW_REQUIRED' });
}));

test('property: approved local quantities remain independent of the historical SO snapshot', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1000000 }), async units => {
    await fixture(async detail => {
      const quantity = units / 100;
      const d = await claim(await prepare(await adjust(detail, quantity)));
      assert.equal(d.purchaseOrderOperationStatus, 'creating');
      assert.equal(d.purchaseOrderLines[0].quantity, quantity);
      assert.equal(d.salesOrderLines[0].quantity, 10);
      assert.equal((await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: 8877480 })).attention, false);
    });
  }), { seed: 111, numRuns: 12 });
});

