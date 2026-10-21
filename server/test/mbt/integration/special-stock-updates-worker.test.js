import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';

after(closeDb);
test('Worker preserves Pending Update and blocks stock readiness until Sales replies', async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-updates-db-20261002');
  const tx = await beginRollbackContext();
  try {
    await tx.run(async () => {
      const actor = 'stock-update-worker-test', context = { operatorId: actor, authorizedStoreLocationIds: [1] };
      await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST Worker','test','test','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING", [actor]);
      const detail = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Worker', vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
        lines: [{ productName: 'TEST material', quantity: 1, uom: 'PLT', rate: 10, requiredDate: '2099-02-01' }] }, context);
      await query("UPDATE sales_special_stock_cases SET information_request=$2::jsonb WHERE request_id=$1", [detail.id, JSON.stringify({ status: 'pending', question: 'Size?' })]);
      await query("UPDATE sales_special_stock_lines SET supply_status='in_stock',sales_decision='accepted' WHERE request_id=$1", [detail.id]);
      assert.equal((await repo.getSpecialStockCase(detail.id)).stage, 'pending_update');
      await assert.rejects(() => repo.checkSpecialStockReadiness(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, ready: true }, context), { code: 'SPECIAL_UPDATE_PENDING' });
      assert.equal((await repo.getSpecialStockCase(detail.id)).revision, detail.revision);
    });
  } finally { await tx.rollback(); }
});

const actor = 'stock-update-worker-available-test', context = { operatorId: actor, authorizedStoreLocationIds: [1] };
const response = { supplyStatus: 'low_inventory', availabilityMode: 'no_projection', vendorId: 8899200, vendorName: 'TEST Vendor', vendorYard: 'TEST Yard' };
async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-updates-db-20261002');
  const tx = await beginRollbackContext();
  try { await tx.run(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST Worker Available','test','test','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING", [actor]);
    const detail = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Worker', vendorId: 8899200, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
      lines: [{ productName: 'TEST material', quantity: 1, uom: 'PLT', rate: 10, requiredDate: '2099-02-01' }] }, context);
    await run(detail);
  }); } finally { await tx.rollback(); }
}
test('Accepted Low inventory remains ready, permits a dispatch handoff and vendor collection, while unavailable stock is blocked', () => fixture(async d => {
  let detail = await repo.respondSpecialStockLine(d.id, d.lines[0].id, { ...response, expectedRevision: d.revision, supplyStatus: 'no_stock' }, context);
  await assert.rejects(() => repo.decideSpecialStockLine(d.id, d.lines[0].id, { expectedRevision: detail.revision, decision: 'accepted' }, context), { code: 'SPECIAL_ETA_REQUIRED' });
  detail = await repo.respondSpecialStockLine(d.id, d.lines[0].id, { ...response, expectedRevision: detail.revision }, context);
  detail = await repo.decideSpecialStockLine(d.id, d.lines[0].id, { expectedRevision: detail.revision, decision: 'accepted' }, context);
  const so = 920000000000 + d.id * 2, po = so + 1;
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES($1,$2,'Pending Fulfillment',true)", [so, `TEST-SO-LOW-${so}`]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES($1,$2,'Pending Receipt',true)", [po, `TEST-PO-LOW-${po}`]);
  await query("INSERT INTO inventory_items(item_id,item_name) VALUES(2055,'MBBS-Special Order') ON CONFLICT DO NOTHING");
  for (const kind of ['sales_order', 'purchase_order']) await query(`INSERT INTO sales_special_stock_order_lines(request_id,case_line_id,order_kind,item_id,item_name,description,quantity,uom,remote_line_id)
    VALUES($1,$2,$3,2055,'MBBS-Special Order','TEST product',1,'PLT',1)`, [d.id, d.lines[0].id, kind]);
  await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=$2,sales_order_ref=$3,sales_order_approved=true,purchase_order_netsuite_id=$4,purchase_order_ref=$5 WHERE request_id=$1", [d.id, so, `TEST-SO-LOW-${so}`, po, `TEST-PO-LOW-${po}`]);
  detail = await repo.checkSpecialStockReadiness(d.id, d.lines[0].id, { expectedRevision: detail.revision, ready: true }, context);
  assert.equal(detail.lines[0].supplyStatus, 'low_inventory'); assert.equal(detail.readinessAlerts.length, 0);
  assert.equal(detail.handoff.status, 'waiting_route'); assert.equal(detail.stage, 'dispatch_arrangement');
  await query("UPDATE sales_special_stock_cases SET fulfillment_method='vendor_pickup' WHERE request_id=$1", [d.id]);
  const pickup = { expectedRevision: detail.revision, pickupDate: '2099-02-01', pickupReference: 'Customer collection receipt' };
  await query("UPDATE sales_special_stock_lines SET supply_status='production' WHERE request_id=$1", [d.id]);
  await assert.rejects(() => repo.completeSpecialVendorPickup(d.id, pickup, context), { code: 'SPECIAL_STOCK_NOT_READY' });
  await query("UPDATE sales_special_stock_lines SET supply_status='low_inventory' WHERE request_id=$1", [d.id]);
  assert.equal((await repo.completeSpecialVendorPickup(d.id, pickup, context)).stage, 'completed');
}));
