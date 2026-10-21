import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { query, closeDb } from '/app/src/db.js';
import { createSpecialStockCase } from '/app/src/special-stock-request-repository.js';
import { processNetSuiteOrderWebhook } from '/app/src/server.js';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
const caseIds = [], soId = 990973101, poId = 990973102, actor = 'shared-image-test';
let flag;
try {
  for (const [file, expected] of Object.entries(JSON.parse(process.env.SHARED_IMAGE_HASHES))) {
    assert.equal(createHash('sha256').update(readFileSync('/app/' + file)).digest('hex'), expected, file);
  }
  flag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST','hash','salt','sales',ARRAY['sales'],ARRAY[1])", [actor]);
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(990973100,'TEST-SHARED-IMAGE','TEST Shared','TEST Shared','CAD',true,now(),'test',repeat('e',64)) ON CONFLICT DO NOTHING");
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
  await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,status,status_text,netsuite_active) VALUES($1,'TEST-SHARED-IMAGE-SO',990973100,1,'B','Pending Fulfillment',true)", [soId]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status,status_text,netsuite_active) VALUES($1,'TEST-SHARED-IMAGE-PO',331,1,'B','Pending Receipt',true)", [poId]);
  await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,973101,2055,'MBBS-Special Order','Shared material',100,'PC',true)", [soId]);
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,973201,2055,'MBBS-Special Order','Shared material',100,'PC',true)", [poId]);
  for (let index = 0; index < 2; index++) {
    const d = await createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 990973100,
      customerName: 'TEST Shared', vendorId: 331, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
      lines: [{ productName: 'TEST Shared Material', quantity: 12, uom: 'PCS', rate: 4, requiredDate: '2099-02-01' }] },
    { operatorId: actor, authorizedStoreLocationIds: [1] });
    caseIds.push(d.id);
    await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=$2,sales_order_ref='TEST-SHARED-IMAGE-SO',sales_order_source='manual_link',sales_order_operation_status='linked',sales_order_approved=true,purchase_order_netsuite_id=$3,purchase_order_ref='TEST-SHARED-IMAGE-PO',purchase_order_custom_linkage=true,purchase_order_operation_status='linked' WHERE request_id=$1", [d.id, soId, poId]);
  }
  for (const [kind, id, reference, line] of [['salesorder', soId, 'TEST-SHARED-IMAGE-SO', 973101], ['purchaseorder', poId, 'TEST-SHARED-IMAGE-PO', 973201]]) {
    const result = await processNetSuiteOrderWebhook({ id, recordType: kind, tranid: reference,
      status: 'A', statusText: 'Pending Approval', entityId: kind === 'salesorder' ? 990973100 : 331, locationId: 1,
      lines: [{ lineUniqueKey: line, orderLine: 1, itemId: 2055, itemName: 'MBBS-Special Order', itemType: 'InvtPart', quantity: 100, unit: 'PC', locationId: 1 }] },
    { scheduleDelayedStatus: false, emitEvents: false });
    assert.deepEqual(result.results.filter(row => row.target === 'sales_special_stock_cases').map(row => row.requestId), caseIds);
    assert.equal(result.specialStockRequest.attention, false);
  }
  const saved = (await query('SELECT special.request_id,special.sales_order_approved,request.revision FROM sales_special_stock_cases special JOIN sales_stock_requests request ON request.id=special.request_id WHERE special.request_id=ANY($1::bigint[]) ORDER BY request_id', [caseIds])).rows;
  assert.equal(saved.length, 2);
  assert.ok(saved.every(row => row.sales_order_approved === false && Number(row.revision) === 3));
  console.log(JSON.stringify({ imageSourceVerified: true, sharedCases: 2, webhookKinds: ['SO', 'PO'], allCasesUpdated: true }));
} finally {
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [caseIds]);
  await query('DELETE FROM sales_order_lines WHERE sales_order_id=$1', [soId]);
  await query('DELETE FROM purchase_order_lines WHERE purchase_order_id=$1', [poId]);
  await query('DELETE FROM sales_orders WHERE netsuite_id=$1', [soId]);
  await query('DELETE FROM purchase_orders WHERE netsuite_id=$1', [poId]);
  await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1', [actor]);
  await query('DELETE FROM operators WHERE id=$1', [actor]);
  if (flag !== undefined) { await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [flag]); }
  await closeDb();
}
