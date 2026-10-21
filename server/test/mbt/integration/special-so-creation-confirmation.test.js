import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
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

test('confirmed SO links without comparing the saved draft to edited mirror content', () => fixture(async detail => {
  const beforeScm = await repo.getSpecialStockCase(detail.id, { audience: 'scm' });
  const linked = await link(detail);
  assert.equal(linked.salesOrderId, 8877480);
  assert.equal(linked.salesOrderRef, 'TEST-SO-CONFIRMED');
  assert.equal(linked.salesOrderOperationStatus, 'linked');
  assert.equal(linked.attention, false);
  assert.deepEqual(linked.salesOrderLines, detail.salesOrderLines);
  assert.equal(linked.events.find(event => event.eventType === 'special_sales_order_linked').details.lineReconciliation, 'creation_confirmed');
  const reconciled = await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: 8877480 });
  assert.equal(reconciled.attention, false);
  const after = await repo.getSpecialStockCase(detail.id, { audience: 'scm' });
  assert.equal(after.salesOrderOperationStatus, 'linked');
  assert.equal(after.attention, false);
  assert.deepEqual(after.salesOrderLines, beforeScm.salesOrderLines);
}));

test('native PO claim resolves exact SO line identities at the PO boundary', () => fixture(async detail => {
  await query("UPDATE sales_orders SET customer_id=8877477,order_location_id=1 WHERE netsuite_id=8877480");
  await query("UPDATE sales_order_lines SET item_description='TEST Material',quantity=10,unit='PC' WHERE sales_order_id=8877480");
  let linked = await link(detail);
  assert.equal(linked.salesOrderLines[0].remoteLineId, null);
  linked = await repo.prepareSpecialPurchaseOrder(detail.id, { expectedRevision: linked.revision,
    pallet: { quantity: 0 }, lines: [{ caseLineId: detail.lines[0].id, description: 'TEST Material', quantity: 10,
      uom: 'PC', unitPurchaseCost: 2, vendorDiscountPercent: 0 }] }, context);
  const claimed = await repo.claimSpecialOrderOperation(detail.id, { expectedRevision: linked.revision,
    orderKind: 'purchase_order', operationId: '01911111-1111-7111-8111-111111122477' }, context);
  assert.equal(claimed.salesOrderLines[0].remoteLineId, 88774801);
  assert.equal(claimed.salesOrderOperationStatus, 'linked');
}));

test('confirmed SO keeps local revision and yard authorization checks', () => fixture(async detail => {
  const params = { expectedRevision: detail.revision, salesOrderId: 8877480,
    salesOrderRef: 'TEST-SO-CONFIRMED', source: 'standalone', verifiedRemote: true };
  await assert.rejects(repo.linkSpecialSalesOrder(detail.id, { ...params, expectedRevision: detail.revision + 1 }, context), { code: 'SPECIAL_REVISION_CONFLICT' });
  await assert.rejects(repo.linkSpecialSalesOrder(detail.id, params, { ...context, authorizedStoreLocationIds: [28] }), { code: 'SPECIAL_CASE_STORE_FORBIDDEN' });
}));
