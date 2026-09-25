import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repository from '../../../src/special-stock-request-repository.js';

after(closeDb);
const context = { operatorId: 'special-polish-test', authorizedStoreLocationIds: [1] };
const gate = 'special_stock_request_test_skip_orders';
async function fixture(run) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('special-polish-test','special-polish-test','TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING");
      await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING");
      await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899100,'TEST','TEST Review','TEST Review','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
      await query("INSERT INTO mbt_feature_flags(flag_key,enabled,description) VALUES($1,false,'TEST') ON CONFLICT (flag_key) DO UPDATE SET enabled=false", [gate]);
      await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
      await run();
    });
  } finally { await rollback.rollback(); }
}
async function draft({ fulfillmentMethod = 'yard_pickup', production = false } = {}) {
  let detail = await repository.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 8899100,
    customerName: 'TEST Review', vendorId: 8899200, vendorName: 'TEST Vendor', fulfillmentMethod,
    deliveryAddress: 'TEST address',
    lines: [{ productName: 'TEST product', quantity: 2, uom: 'PLT', rate: 144, requiredDate: '2099-02-01' }] }, context);
  detail = await repository.respondSpecialStockLine(detail.id, detail.lines[0].id, {
    expectedRevision: detail.revision, supplyStatus: production ? 'production' : 'in_stock',
    availabilityMode: production ? 'dated' : 'no_projection', availableDate: production ? '2099-01-20' : null,
    vendorId: 8899200, vendorName: 'TEST Vendor', vendorYard: 'TEST vendor yard'
  }, context);
  detail = await repository.decideSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, decision: 'accepted' }, context);
  return repository.saveSpecialSalesOrderDraft(detail.id, { expectedRevision: detail.revision,
    customerId: 8899100, operationalYardLocationId: 1, fulfillmentMethod, deliveryAddress: 'TEST address', palletTotal: 0,
    materialLines: [{ caseLineId: detail.lines[0].id, itemId: 2055, quantity: 24, packageQuantity: 2, conversionToPc: 12, uom: 'PC', rate: 144, description: 'TEST product in pieces' }] }, context);
}
async function skip(detail, orderKind = 'sales_order', extra = {}, caller = context) {
  return repository.skipSpecialOrderCreation(detail.id, { expectedRevision: detail.revision, orderKind, ...extra }, caller);
}
function purchaseLines(detail) {
  return detail.purchaseOrderLines.map(line => ({ caseLineId: line.caseLineId, description: 'TEST revised purchase description', quantity: 2, uom: 'PC', unitPurchaseCost: 4 }));
}

test('skip requires the gate, yard access and a saved SO draft', () => fixture(async () => {
  const detail = await draft();
  await assert.rejects(() => skip(detail), { code: 'SPECIAL_TEST_SKIP_DISABLED' });
  await query('UPDATE mbt_feature_flags SET enabled=true WHERE flag_key=$1', [gate]);
  await assert.rejects(() => skip(detail, 'sales_order', {}, { ...context, authorizedStoreLocationIds: [28] }), { code: 'SPECIAL_CASE_STORE_FORBIDDEN' });
  await query("DELETE FROM sales_special_stock_order_lines WHERE request_id=$1", [detail.id]);
  await assert.rejects(() => skip(detail), { code: 'SPECIAL_SO_DRAFT_REQUIRED' });
  assert.equal((await repository.getSpecialStockCase(detail.id)).salesOrderSkipped, false);
}));

test('skipped SO and PO advance stage with durable audits, no remote IDs and no live Dispatch handoff', () => fixture(async () => {
  let detail = await draft();
  await query('UPDATE mbt_feature_flags SET enabled=true WHERE flag_key=$1', [gate]);
  const before = detail;
  detail = await skip(detail);
  assert.equal(detail.salesOrderSkipped, true);
  assert.equal(detail.salesOrderApproved, true);
  assert.equal(detail.salesOrderId, null);
  assert.equal(detail.salesOrderRef, null);
  assert.equal(detail.stage, 'confirmed');
  await assert.rejects(() => skip(before), { code: 'SPECIAL_REVISION_CONFLICT' });
  const repeated = await skip(detail);
  assert.equal(repeated.revision, detail.revision);
  detail = await skip(detail, 'purchase_order', { lines: purchaseLines(detail) });
  assert.equal(detail.purchaseOrderSkipped, true);
  assert.equal(detail.purchaseOrderId, null);
  assert.equal(detail.stage, 'dispatch_arrangement');
  assert.equal(detail.handoff, null);
  assert.equal(detail.salesOrderLines[0].description, 'TEST revised purchase description');
  assert.equal(detail.salesOrderLines[0].quantity, 24);
  assert.equal(detail.salesOrderLines[0].rate, 12);
  assert.equal(detail.events.filter(event => event.eventType === 'special_sales_order_creation_skipped').length, 1);
  assert.equal(detail.events.filter(event => event.eventType === 'special_purchase_order_creation_skipped').length, 1);
  await query('UPDATE mbt_feature_flags SET enabled=false WHERE flag_key=$1', [gate]);
  assert.equal((await repository.getSpecialStockCase(detail.id)).stage, 'dispatch_arrangement');
  assert.equal((await repository.listSpecialStockCases({ stages: ['dispatch_arrangement'], limit: 150 })).some(row => row.id === detail.id), true);
  assert.equal((await repository.listSpecialDispatchHandoffs()).some(row => row.requestId === detail.id), false);
  for (const [fn, input] of [
    ['linkSpecialSalesOrder', { salesOrderId: 12345, salesOrderRef: 'SHOULD-NOT-LINK' }],
    ['linkSpecialPurchaseOrder', { purchaseOrderId: 12346, purchaseOrderRef: 'SHOULD-NOT-LINK' }],
    ['claimSpecialOrderOperation', { orderKind: 'sales_order', operationId: 'd9c97e50-5c7d-4227-8d37-000000000001' }],
    ['setSpecialSalesOrderStatus', { salesOrderStatus: 'Pending Fulfillment', approved: true }]
  ]) {
    await assert.rejects(() => repository[fn](detail.id, { expectedRevision: detail.revision, ...input }, context), { code: 'SPECIAL_TEST_ORDER_REMOTE_BLOCKED' });
  }
}));

test('PO test skip is atomic on invalid review and blocked for real or uncertain target orders', () => fixture(async () => {
  let detail = await draft();
  await query('UPDATE mbt_feature_flags SET enabled=true WHERE flag_key=$1', [gate]);
  await assert.rejects(() => skip(detail, 'purchase_order', { lines: purchaseLines(detail) }), { code: 'SPECIAL_PO_SO_NOT_APPROVED' });
  await query("UPDATE sales_special_stock_cases SET sales_order_operation_status='attention' WHERE request_id=$1", [detail.id]);
  await assert.rejects(() => skip(detail), { code: 'SPECIAL_OPERATION_BUSY' });
  await query("UPDATE sales_special_stock_cases SET sales_order_operation_status='idle',sales_order_netsuite_id=9912345,sales_order_ref='TEST existing' WHERE request_id=$1", [detail.id]);
  await assert.rejects(() => skip(detail), { code: 'SPECIAL_SO_ALREADY_LINKED' });
  await query('UPDATE sales_special_stock_cases SET sales_order_netsuite_id=null,sales_order_ref=null WHERE request_id=$1', [detail.id]);
  detail = await skip(detail);
  await assert.rejects(() => skip(detail, 'purchase_order', { lines: [{ ...purchaseLines(detail)[0], unitPurchaseCost: '' }] }), { code: 'SPECIAL_PO_LINES_INVALID' });
  const current = await repository.getSpecialStockCase(detail.id);
  assert.equal(current.revision, detail.revision);
  assert.equal(current.purchaseOrderSkipped, false);
  assert.equal(current.purchaseOrderLines[0].description, detail.purchaseOrderLines[0].description);
}));

test('test skips preserve production waiting and allow evidence-backed vendor collection', () => fixture(async () => {
  let detail = await draft({ fulfillmentMethod: 'vendor_pickup', production: true });
  await query('UPDATE mbt_feature_flags SET enabled=true WHERE flag_key=$1', [gate]);
  detail = await skip(detail);
  detail = await skip(detail, 'purchase_order', { lines: purchaseLines(detail) });
  assert.equal(detail.stage, 'wait_for_production');
  detail = await repository.checkSpecialStockReadiness(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, ready: true }, context);
  assert.equal(detail.stage, 'confirmed');
  detail = await repository.completeSpecialVendorPickup(detail.id, { expectedRevision: detail.revision, pickupDate: '2099-01-21', pickupReference: 'TEST collection only' }, context);
  assert.equal(detail.stage, 'completed');
  assert.equal((await repository.listSpecialStockCases({ stages: ['completed'], limit: 150 })).some(row => row.id === detail.id), true);
}));
