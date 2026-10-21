import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { getSpecialSalesAlertCounts, getSpecialStockAlertCounts } from '../../../src/special-stock-alerts.js';
after(closeDb);
const actor = 'special-update-test', context = { operatorId: actor, authorizedStoreLocationIds: [1] };
const migration = 'migrations/258_special_stock_information.sql';
const response = { supplyStatus: 'low_inventory', availabilityMode: 'no_projection', vendorId: 8899200, vendorName: 'TEST Vendor', vendorYard: 'TEST Yard' };
async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
  const tx = await beginRollbackContext();
  try { await tx.run(async () => {
    if (existsSync(migration)) { const sql = await readFile(migration, 'utf8'); await query(sql); await query(sql); }
    await query(await readFile('migrations/283_special_customer_confirmation.sql', 'utf8'));
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST Update Rep','hash','salt','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING", [actor]);
    const d = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Update', vendorId: 8899200, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
      lines: [{ productName: 'TEST product', quantity: 1, uom: 'PLT', rate: 10, requiredDate: '2099-02-01' }] }, context);
    await run(d);
  }); } finally { await tx.rollback(); }
}
test('SCM question pauses stock check, alerts scoped Sales, records reply, and returns to SCM', () => fixture(async d => {
  const initialSales = await getSpecialSalesAlertCounts(context), initialScm = await getSpecialStockAlertCounts();
  const pending = await repo.requestSpecialStockInformation(d.id, { expectedRevision: d.revision, question: 'Please confirm size <large>.' }, context);
  assert.equal(pending.stage, 'pending_update'); assert.equal(pending.revision, d.revision + 1);
  assert.equal(pending.informationRequest.question, 'Please confirm size <large>.');
  assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1', [d.id])).rows[0].stage, pending.stage);
  assert.equal((await repo.listSpecialStockCases({ audience: 'sales', stages: 'pending_update', authorizedStoreLocationIds: [1] })).some(row => row.id === d.id), true);
  assert.equal((await getSpecialSalesAlertCounts(context)).pendingUpdate, (initialSales.pendingUpdate || 0) + 1);
  assert.equal((await getSpecialSalesAlertCounts({ ...context, authorizedStoreLocationIds: [28] })).total, 0);
  assert.equal((await getSpecialStockAlertCounts()).newRequests, initialScm.newRequests - 1);
  await assert.rejects(() => repo.respondSpecialStockLine(d.id, d.lines[0].id, { ...response, expectedRevision: pending.revision }, context), { code: 'SPECIAL_UPDATE_PENDING' });
  await assert.rejects(() => repo.saveSpecialSalesOrderDraft(d.id, { expectedRevision: pending.revision }, context), { code: 'SPECIAL_UPDATE_PENDING' });
  await assert.rejects(() => repo.submitSpecialStockInformation(d.id, { expectedRevision: pending.revision, reply: 'Size is large.' }, { ...context, authorizedStoreLocationIds: [28] }), { code: 'SPECIAL_CASE_STORE_FORBIDDEN' });
  await assert.rejects(() => repo.submitSpecialStockInformation(d.id, { expectedRevision: d.revision, reply: 'Size is large.' }, context), { code: 'SPECIAL_REVISION_CONFLICT' });
  const resumed = await repo.submitSpecialStockInformation(d.id, { expectedRevision: pending.revision, reply: 'Size is large.' }, context);
  assert.equal(resumed.stage, 'new_enquiry'); assert.equal(resumed.informationRequest.status, 'answered');
  assert.equal(resumed.informationRequest.reply, 'Size is large.');
  assert.equal((await getSpecialSalesAlertCounts(context)).pendingUpdate || 0, initialSales.pendingUpdate || 0);
  assert.equal(resumed.events.filter(event => event.eventType === 'special_information_requested').length, 1);
  assert.equal(resumed.events.filter(event => event.eventType === 'special_information_updated').length, 1);
  const checked = await repo.respondSpecialStockLine(d.id, d.lines[0].id, { ...response, expectedRevision: resumed.revision }, context);
  assert.equal(checked.lines[0].supplyStatus, 'low_inventory');
  await assert.rejects(() => repo.requestSpecialStockInformation(d.id, { expectedRevision: checked.revision, question: 'Ask after checking?' }, context), { code: 'SPECIAL_INFORMATION_LOCKED' });
  const accepted = await repo.decideSpecialStockLine(d.id, d.lines[0].id, { expectedRevision: checked.revision, decision: 'accepted' }, context);
  assert.equal(accepted.stage, 'confirmed');
  assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1', [d.id])).rows[0].stage, accepted.stage);
}));
test('Pending information rejects blank/oversized notes, duplicate requests and issued or closed cases', () => fixture(async d => {
  for (const question of ['', '  ', 'x'.repeat(4001), 'bad\u0000note', { unsafe: true }]) await assert.rejects(() => repo.requestSpecialStockInformation(d.id, { expectedRevision: d.revision, question }, context), { code: 'SPECIAL_INFORMATION_REQUIRED' });
  await assert.rejects(() => repo.requestSpecialStockInformation(d.id, { expectedRevision: d.revision, question: 'Size?' }, {}), { code: 'SPECIAL_ACTOR_REQUIRED' });
  const pending = await repo.requestSpecialStockInformation(d.id, { expectedRevision: d.revision, question: 'Size?' }, context);
  await assert.rejects(() => repo.requestSpecialStockInformation(d.id, { expectedRevision: pending.revision, question: 'Size again?' }, context), { code: 'SPECIAL_UPDATE_PENDING' });
  await assert.rejects(() => repo.submitSpecialStockInformation(d.id, { expectedRevision: pending.revision, reply: ' ' }, context), { code: 'SPECIAL_INFORMATION_REQUIRED' });
  const resumed = await repo.submitSpecialStockInformation(d.id, { expectedRevision: pending.revision, reply: 'Large.' }, context);
  await assert.rejects(() => repo.submitSpecialStockInformation(d.id, { expectedRevision: resumed.revision, reply: 'Again.' }, context), { code: 'SPECIAL_UPDATE_NOT_PENDING' });
  await query('UPDATE sales_special_stock_cases SET sales_order_skipped=true WHERE request_id=$1', [d.id]);
  await assert.rejects(() => repo.requestSpecialStockInformation(d.id, { expectedRevision: resumed.revision, question: 'Size?' }, context), { code: 'SPECIAL_INFORMATION_LOCKED' });
  await query("UPDATE sales_special_stock_cases SET sales_order_skipped=false,close_status='closed' WHERE request_id=$1", [d.id]);
  await assert.rejects(() => repo.requestSpecialStockInformation(d.id, { expectedRevision: resumed.revision, question: 'Size?' }, context), { code: 'SPECIAL_INFORMATION_LOCKED' });
}));

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
  assert.equal((await repo.completeSpecialVendorPickup(d.id, pickup, context)).stage, 'confirmed');
}));
