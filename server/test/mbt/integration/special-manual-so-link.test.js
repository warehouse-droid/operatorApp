import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';

after(closeDb);
const context = { operatorId: 'manual-so-link-test', authorizedStoreLocationIds: [1] };
async function fixture(run) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('manual-so-link-test','manual-so-link-test','TEST','hash','salt','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING");
      await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899600,'TEST-LINK','TEST Link','TEST Link','CAD',true,now(),'test',repeat('e',64)) ON CONFLICT DO NOTHING");
      await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
      await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING");
      const detail = await accepted();
      await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,customer,order_location_id,status,status_text,netsuite_active) VALUES(8899601,'TEST-SO-LINK',8899600,'TEST Link',1,'B','Pending Fulfillment',true)");
      await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES(8899601,960101,2055,'MBBS-Special Order','Different existing description',80,'SQFT',true)");
      await run(detail);
    });
  } finally { await rollback.rollback(); }
}
async function accepted() {
  let d = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01',
    customerId: 8899600, customerName: 'TEST Link', vendorId: 8899602, vendorName: 'TEST Vendor',
    fulfillmentMethod: 'yard_pickup', lines: [{ productName: 'TEST Material', quantity: 80,
      uom: 'SQFT', rate: 7.88, requiredDate: '2099-02-01' }] }, context);
  d = await repo.respondSpecialStockLine(d.id, d.lines[0].id, { expectedRevision: d.revision,
    supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 8899602,
    vendorName: 'TEST Vendor', vendorYard: 'TEST Yard' }, context);
  return repo.decideSpecialStockLine(d.id, d.lines[0].id, { expectedRevision: d.revision, decision: 'accepted' }, context);
}
const input = (d, extra = {}) => ({ expectedRevision: d.revision, salesOrderRef: 'TEST-SO-LINK', ...extra });

test('manual reference-only link accepts unmapped lines without a saved draft and preserves enquiry data', () => fixture(async d => {
  assert.equal(d.lines[0].itemResolution, null);
  assert.equal(d.salesOrderLines.length, 0);
  const linked = await repo.linkSpecialSalesOrder(d.id, input(d), context);
  assert.equal(linked.salesOrderId, 8899601);
  assert.equal(linked.salesOrderRef, 'TEST-SO-LINK');
  assert.equal(linked.salesOrderSource, 'manual_link');
  assert.equal(linked.salesOrderApproved, true);
  assert.equal(linked.salesOrderOperationStatus, 'linked');
  assert.equal(linked.attention, false);
  assert.deepEqual(linked.lines, d.lines);
  assert.equal(linked.salesOrderLines.length, 0);
  assert.equal(linked.events.filter(event => event.eventType === 'special_sales_order_linked').length, 1);
  const synced = await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: 8899601 });
  assert.equal(synced.matched, true);
  const after = await repo.getSpecialStockCase(d.id, { audience: 'sales', authorizedStoreLocationIds: [1] });
  assert.equal(after.attention, false);
  assert.equal(after.salesOrderId, 8899601);
}));

test('manual link ignores a mismatched saved draft and later webhook line-coverage checks', () => fixture(async d => {
  await query("INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_rate) VALUES($1,'sales_order',true,1784,'PALLET','PALLET',2,'EACH',40)", [d.id]);
  const linked = await repo.linkSpecialSalesOrder(d.id, input(d, { salesOrderId: 8899601 }), context);
  assert.equal(linked.salesOrderId, 8899601);
  assert.equal(linked.attention, false);
  await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: 8899601 });
  assert.equal((await repo.getSpecialStockCase(d.id, { audience: 'scm' })).attention, false);
}));

test('manual SO number lookup accepts surrounding space and letter case', () => fixture(async d => {
  const linked = await repo.linkSpecialSalesOrder(d.id, input(d, { salesOrderRef: '  test-so-link  ' }), context);
  assert.equal(linked.salesOrderId, 8899601);
  assert.equal(linked.salesOrderRef, 'TEST-SO-LINK');
}));

test('manual linking rejects blank and ambiguous SO numbers', () => fixture(async d => {
  await assert.rejects(() => repo.linkSpecialSalesOrder(d.id, input(d, { salesOrderRef: ' ' }), context), /Sales Order number is required/);
  await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,status_text,netsuite_active) VALUES(8899605,'test-so-link',8899600,1,'Pending Fulfillment',true)");
  await assert.rejects(() => repo.linkSpecialSalesOrder(d.id, input(d), context), { code: 'SPECIAL_SO_REFERENCE_AMBIGUOUS' });
  assert.equal((await repo.getSpecialStockCase(d.id)).salesOrderId, null);
}));

async function saveDraft(d, description = 'TEST Material') {
  return repo.saveSpecialSalesOrderDraft(d.id, { expectedRevision: d.revision, customerId: 8899600,
    operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', palletTotal: 0,
    materialLines: [{ caseLineId: d.lines[0].id, itemId: 2055, description,
      quantity: 80, packageQuantity: 80, conversionToPc: 1, uom: 'SQFT', rate: 7.88 }] }, context);
}

test('manual linking preserves a compatible draft without resolving or comparing its line identities', () => fixture(async d => {
  d = await saveDraft(d, 'Different existing description');
  const linked = await repo.linkSpecialSalesOrder(d.id, input(d), context);
  assert.equal(linked.salesOrderLines[0].remoteLineId, null);
  assert.equal(linked.lines[0].itemResolution.salesUom, 'SQFT');
}));

test('nonmanual links retain strict saved-draft line coverage', () => fixture(async d => {
  d = await saveDraft(d);
  await assert.rejects(() => repo.linkSpecialSalesOrder(d.id, input(d, { salesOrderId: 8899601,
    source: 'standalone' }), context), { code: 'SPECIAL_ORDER_COVERAGE_MISMATCH' });
  assert.equal((await repo.getSpecialStockCase(d.id)).salesOrderId, null);
}));

for (const [label, patch, code] of [
  ['unknown number', { salesOrderRef: 'TEST-UNKNOWN' }, 'SPECIAL_SO_NOT_FOUND'],
  ['conflicting internal ID', { salesOrderId: 8899699 }, 'SPECIAL_SO_REFERENCE_MISMATCH']
]) test(`manual linking rejects ${label}`, () => fixture(async d => {
  await assert.rejects(() => repo.linkSpecialSalesOrder(d.id, input(d, patch), context), { code });
  assert.equal((await repo.getSpecialStockCase(d.id)).salesOrderId, null);
}));

for (const [label, sql] of [
  ['inactive order', 'UPDATE sales_orders SET netsuite_active=false WHERE netsuite_id=8899601'],
  ['closed order', "UPDATE sales_orders SET status_text='Closed' WHERE netsuite_id=8899601"],
  ['different customer', 'UPDATE sales_orders SET customer_id=8899699 WHERE netsuite_id=8899601'],
  ['different yard', 'UPDATE sales_orders SET order_location_id=28 WHERE netsuite_id=8899601'],
  ['pending quantity review', "UPDATE sales_special_stock_cases SET quantity_review='{\"status\":\"pending\"}' WHERE request_id=$1"]
]) test(`manual linking skips ${label} business comparison`, () => fixture(async d => {
  await query(sql, sql.includes('$1') ? [d.id] : []);
  if (label === 'different customer') await query('UPDATE sales_special_stock_cases SET order_customer_netsuite_id=8899600 WHERE request_id=$1', [d.id]);
  const linked=await repo.linkSpecialSalesOrder(d.id,input(d),context);assert.equal(linked.salesOrderId,8899601);
}));
test('manual linking retains active operation integrity',()=>fixture(async d=>{
  await query("UPDATE sales_special_stock_cases SET sales_order_operation_status='attention' WHERE request_id=$1",[d.id]);
  await assert.rejects(()=>repo.linkSpecialSalesOrder(d.id,input(d),context),{code:'SPECIAL_OPERATION_BUSY'});
  assert.equal((await repo.getSpecialStockCase(d.id)).salesOrderId,null);
}));

test('reference-only manual linking uses the existing SO bill-to while preserving the enquiry customer', () => fixture(async d => {
  await query("UPDATE sales_orders SET customer_id=8899609,customer='TEST Existing bill-to' WHERE netsuite_id=8899601");
  const linked = await repo.linkSpecialSalesOrder(d.id, input(d), context);
  assert.equal(linked.salesOrderId, 8899601);
  assert.equal(linked.customerId, 8899600);
  assert.equal(linked.customerName, 'TEST Link');
  assert.equal(linked.netsuiteCustomerId, 8899609);
  assert.equal(linked.netsuiteCustomerName, 'TEST Existing bill-to');
  assert.deepEqual(linked.lines, d.lines);
}));

test('manual linking retains revision and yard authorization', () => fixture(async d => {
  await assert.rejects(() => repo.linkSpecialSalesOrder(d.id, input(d, { expectedRevision: d.revision + 1 }), context), { code: 'SPECIAL_REVISION_CONFLICT' });
  await assert.rejects(() => repo.linkSpecialSalesOrder(d.id, input(d), { ...context, authorizedStoreLocationIds: [28] }), { code: 'SPECIAL_CASE_STORE_FORBIDDEN' });
}));

test('manual linking can share an SO with another enquiry', () => fixture(async d => {
  const other = await accepted();
  await repo.linkSpecialSalesOrder(other.id, input(other), context);
  const linked = await repo.linkSpecialSalesOrder(d.id, input(d), context);
  assert.equal(linked.salesOrderId, 8899601);
  assert.equal((await repo.getSpecialStockCase(other.id)).salesOrderId, 8899601);
}));

test('automatic verified SO creation still requires item mappings', () => fixture(async d => {
  await assert.rejects(() => repo.linkSpecialSalesOrder(d.id, input(d, { salesOrderId: 8899601,
    source: 'standalone', verifiedRemote: true }), context), { code: 'SPECIAL_RELEASE_ITEM_UNRESOLVED' });
}));
