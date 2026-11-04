import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, closeDb } from '../../../src/db.js';
import * as cases from '../../../src/special-stock-request-repository.js';
import { updateScmScheduleEntry } from '../../../src/dispatch-repository.js';
import { listOpenSpecialVendorPickupRequestIds, refreshOpenSpecialVendorPickupOrders } from '../../../src/special-vendor-pickup-refresh.js';

const users = {}, requests = [], salesOrders = [], purchaseOrders = [], plans = [];
let server, base;
const context = () => ({ operatorId: users.sales.id, authorizedStoreLocationIds: [1] });
const load = d => cases.getSpecialStockCase(d.id);

async function call(role, method, path, body) {
  const response = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + users[role].token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}

async function fixture(method) {
  let d = await cases.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Vendor Pickup Replacement',
    vendorId: 331, vendorName: 'TEST Vendor', fulfillmentMethod: method, deliveryAddress: 'TEST Delivery address',
    lines: [{ productName: 'TEST Replacement Material', quantity: 1, uom: 'EACH', rate: 25, requiredDate: '2099-02-01' }] }, context());
  requests.push(d.id);
  d = await cases.saveSpecialStockChecks(d.id, { expectedRevision: d.revision, lines: [{ lineId: d.lines[0].id, kind: 'response',
    supplyStatus: 'production', availabilityMode: 'dated', availableDate: '2099-02-01', vendorId: 331, vendorName: 'TEST Vendor', vendorYard: 'TEST Yard' }] }, { operatorId: users.scm.id });
  d = await cases.saveSpecialCustomerDecisions(d.id, { expectedRevision: d.revision, lines: [{ lineId: d.lines[0].id, decision: 'accepted' }] }, context());
  const so = 93930000 + d.id * 4, po = so + 1;
  salesOrders.push(so, so + 2); purchaseOrders.push(po, po + 2);
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,fulfillment_status,netsuite_active,customer_id,customer)
    VALUES($1,$2,'B','Sales Order : Pending Fulfillment','not_fulfilled',true,8899001,'TEST Original Customer'),
          ($3,$4,'B','Sales Order : Pending Fulfillment','not_fulfilled',true,8899002,'TEST Replacement Customer')`,
  [so, 'TEST-VPR-SO-' + d.id, so + 2, 'TEST-VPR-SO-NEW-' + d.id]);
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,receipt_status,netsuite_active,initial_scm_status,vendor_id,vendor)
    VALUES($1,$2,'B','Purchase Order : Pending Receipt','not_received',true,'Hold',331,'TEST Vendor'),
          ($3,$4,'B','Purchase Order : Pending Receipt','not_received',true,'Hold',331,'TEST Vendor')`,
  [po, 'TEST-VPR-PO-' + d.id, po + 2, 'TEST-VPR-PO-NEW-' + d.id]);
  await query(`UPDATE sales_special_stock_cases SET sales_order_source='standalone',purchase_order_custom_linkage=false,
      sales_order_operation_status='linked',purchase_order_operation_status='linked',operational_yard_location_id=1,
      sales_order_netsuite_id=$2,sales_order_ref=$3,purchase_order_netsuite_id=$4,purchase_order_ref=$5,sales_order_approved=true
    WHERE request_id=$1`, [d.id, so, 'TEST-VPR-SO-' + d.id, po, 'TEST-VPR-PO-' + d.id]);
  for (const [kind, remote] of [['sales_order', 7001], ['purchase_order', 7002]]) {
    await query(`INSERT INTO sales_special_stock_order_lines(request_id,case_line_id,order_kind,item_id,item_name,description,quantity,uom,remote_line_id)
      VALUES($1,$2,$3,2055,'MBBS-Special Order','TEST Replacement Material',1,'EACH',$4)`, [d.id, d.lines[0].id, kind, remote + d.id * 10]);
  }
  return load(d);
}

async function schedule(d, status, reference) {
  const ref = reference === undefined ? d.purchaseOrderReference : reference;
  const existing = (await query("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS token FROM scm_transport_schedule WHERE order_kind='PO' AND lower(order_ref)=lower($1)",
    [d.purchaseOrderReference || d.purchaseOrderRef])).rows[0];
  await updateScmScheduleEntry({ orderKind: 'PO', orderRef: d.purchaseOrderReference || d.purchaseOrderRef, expectedUpdatedAt: existing?.token || null,
    patch: { status, packingSlipRef: ref, method: 'MBT' }, updatedBy: users.scm.id });
  return load(d);
}

async function projections(d, stage) {
  assert.equal(d.stage, stage, d.requestRef);
  assert.equal(d.operationallyComplete, stage === 'completed');
  assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1', [d.id])).rows[0].stage, stage);
  for (const role of ['sales', 'scm']) {
    const path = `/api/${role}/special-stock-requests`;
    const detail = await call(role, 'GET', `${path}/${d.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body)); assert.equal(detail.body.stage, stage);
    const list = await call(role, 'GET', `${path}?stages=${stage}&search=${d.requestRef}`);
    assert.ok(list.body.requests.some(row => row.id === d.id && row.stage === stage), `${role} ${stage} filter`);
  }
}

async function handoff(d, route = null, status = 'waiting_route') {
  await query(`INSERT INTO sales_special_stock_handoffs(request_id,route,status,sales_order_netsuite_id,purchase_order_netsuite_id,
      pickup_address,destination_address,operational_yard_location_id)
    VALUES($1,$2,$3,$4,$5,'TEST Yard','TEST Delivery address',1)`, [d.id, route, status, d.salesOrderId, d.purchaseOrderId]);
  if (route) { await query('UPDATE sales_special_stock_cases SET handoff_route=$2 WHERE request_id=$1', [d.id, route]); }
}

const remoteLines = async d => Object.fromEntries((await query(
  'SELECT order_kind,remote_line_id FROM sales_special_stock_order_lines WHERE request_id=$1 AND ancillary=false', [d.id])).rows
  .map(row => [row.order_kind, row.remote_line_id === null ? null : Number(row.remote_line_id)]));

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1'); assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  for (const [role, yard] of [['sales', 1], ['scm', 1], ['otherSales', 28]]) {
    const username = 'vendor-pickup-replace-' + role + '-' + crypto.randomUUID(), password = crypto.randomUUID();
    const operatorRole = role === 'otherSales' ? 'sales' : role;
    users[role] = await createOperator({ username, password, displayName: 'TEST ' + role, role: operatorRole, roles: [operatorRole], yardLocationIds: [yard] });
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200); users[role].token = (await response.json()).token;
  }
});

after(async () => {
  try {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await query('DELETE FROM dispatch_plan_order_assignments WHERE plan_id=ANY($1::bigint[])', [plans]);
    await query('DELETE FROM dispatch_plans WHERE id=ANY($1::bigint[])', [plans]);
    await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [requests]);
    await query("DELETE FROM scm_transport_schedule WHERE order_kind='PO' AND order_ref LIKE 'TEST-VPR-%'");
    await query('DELETE FROM dispatch_so_po_allocations WHERE sales_order_id=ANY($1::bigint[]) OR po_order_id=ANY($2::bigint[])', [salesOrders, purchaseOrders]);
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])', [salesOrders]);
    await query('DELETE FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[])', [purchaseOrders]);
    await query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])', [purchaseOrders]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])', [salesOrders]);
    for (const user of Object.values(users)) { await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1', [user.id]); await query('DELETE FROM operators WHERE id=$1', [user.id]); }
  } finally { await closeDb(); }
});

test('Special vendor pickup arranges collection once the PO reference is Queued and completes on a fulfilled or billed SO', async () => {
  for (const [status, statusText, fulfillment] of [['G', 'Sales Order : Billed', 'not_fulfilled'], ['F', 'Sales Order : Pending Billing', 'not_fulfilled'],
    ['B', 'Sales Order : Pending Fulfillment', 'fulfilled']]) {
    let d = await fixture('vendor_pickup'); await projections(d, 'confirmed');
    await query('UPDATE sales_special_stock_cases SET purchase_order_sent_to_vendor_at=now() WHERE request_id=$1', [d.id]);
    d = await schedule(await load(d), 'Hold', 'TEST-VPR-REF-' + d.id); await projections(d, 'waiting_vendor_confirmation');
    d = await schedule(d, 'Queued'); await projections(d, 'dispatch_arrangement');
    await query("UPDATE sales_orders SET status='E',status_text='Sales Order : Partially Fulfilled' WHERE netsuite_id=$1", [d.salesOrderId]);
    await projections(await load(d), 'dispatch_arrangement');
    await query('UPDATE sales_orders SET status=$2,status_text=$3,fulfillment_status=$4 WHERE netsuite_id=$1', [d.salesOrderId, status, statusText, fulfillment]);
    d = await load(d); await projections(d, 'completed');
    assert.equal(d.operationalCompletionSource, 'netsuite_order_completion');
    assert.equal(d.purchaseOrderReceiptStatus, 'not_received', 'The vendor-yard PO receipt is not required.');
  }
});

test('a closed SO does not complete a vendor pickup and other delivery methods keep their PO arrival rule', async () => {
  const pickup = await fixture('vendor_pickup');
  await query("UPDATE sales_orders SET status='H',status_text='Sales Order : Closed' WHERE netsuite_id=$1", [pickup.salesOrderId]);
  assert.notEqual((await load(pickup)).stage, 'completed');
  const yard = await fixture('yard_pickup');
  await query("UPDATE sales_orders SET status='G',status_text='Sales Order : Billed' WHERE netsuite_id=$1", [yard.salesOrderId]);
  await projections(await load(yard), 'confirmed');
});

test('SCM replaces a closed PO; the request follows the new PO with independent linkage', async () => {
  let d = await fixture('yard_pickup');
  await handoff(d);
  await query(`UPDATE sales_special_stock_cases SET purchase_order_sent_to_vendor_at=now(),purchase_order_sent_to_vendor_by=$2,attention=true,
    attention_reason='Purchase Order does not contain the exact reviewed item, quantity, UOM, and description for MBBS-Special Order.' WHERE request_id=$1`, [d.id, users.scm.id]);
  await query("UPDATE purchase_orders SET status='H',status_text='Purchase Order : Closed' WHERE netsuite_id=$1", [d.purchaseOrderId]);
  d = await load(d);
  const path = `/api/scm/special-stock-requests/${d.id}/purchase-order/replace`;
  const newRef = 'TEST-VPR-PO-NEW-' + d.id;
  for (const [role, body, status, code] of [
    ['scm', { expectedRevision: d.revision, purchaseOrderRef: newRef }, 400, 'SPECIAL_ORDER_REPLACE_REASON_REQUIRED'],
    ['scm', { expectedRevision: d.revision, purchaseOrderRef: d.purchaseOrderRef, reason: 'TEST' }, 409, 'SPECIAL_ORDER_REPLACE_SAME'],
    ['scm', { expectedRevision: d.revision, purchaseOrderRef: 'TEST-VPR-MISSING', reason: 'TEST' }, 404, 'SPECIAL_ORDER_REPLACE_NOT_FOUND'],
    ['scm', { expectedRevision: d.revision - 1, purchaseOrderRef: newRef, reason: 'TEST' }, 409, 'SPECIAL_REVISION_CONFLICT'],
    ['sales', { expectedRevision: d.revision, purchaseOrderRef: newRef, reason: 'TEST' }, 403, null]
  ]) {
    const response = await call(role, 'POST', path, body);
    assert.equal(response.status, status, JSON.stringify(response.body));
    if (code) { assert.equal(response.body.code, code); }
  }
  await query("UPDATE sales_special_stock_handoffs SET status='planned' WHERE request_id=$1", [d.id]);
  assert.equal((await call('scm', 'POST', path, { expectedRevision: d.revision, purchaseOrderRef: newRef, reason: 'TEST' })).body.code, 'SPECIAL_ORDER_REPLACE_PLANNED');
  await query("UPDATE sales_special_stock_handoffs SET status='waiting_route' WHERE request_id=$1", [d.id]);
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES(date '2098-01-01'+($1::bigint % 3000)::int,'draft') RETURNING id,plan_date", [d.id])).rows[0]; plans.push(plan.id);
  await query('INSERT INTO dispatch_plan_order_assignments(plan_id,plan_date,order_ref,planned_order_ref) VALUES($1,$2,$3,$3)', [plan.id, plan.plan_date, d.purchaseOrderRef]);
  assert.equal((await call('scm', 'POST', path, { expectedRevision: d.revision, purchaseOrderRef: newRef, reason: 'TEST' })).body.code, 'SPECIAL_ORDER_REPLACE_PLANNED');
  await query("UPDATE dispatch_plans SET status='cancelled' WHERE id=$1", [plan.id]);
  const salesLine = (await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,quantity,netsuite_active) VALUES($1,1,2055,'MBBS-Special Order',1,true) RETURNING id", [d.salesOrderId])).rows[0].id;
  const purchaseLine = (await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,sku,item_name,quantity,unit,netsuite_active) VALUES($1,1,2055,'MBBS-Special Order','MBBS-Special Order',1,'EA',true) RETURNING id", [d.purchaseOrderId])).rows[0].id;
  const allocation = (await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,status,dispatch_target_ref,dispatch_target_line_key)
    VALUES($1,$2,$3,$4,$5,$6,2055,1,'active',$2,$2||'::1') RETURNING id`, [d.salesOrderId, d.salesOrderRef, salesLine, d.purchaseOrderId, d.purchaseOrderRef, purchaseLine])).rows[0].id;
  assert.equal((await call('scm', 'POST', path, { expectedRevision: d.revision, purchaseOrderRef: newRef, reason: 'TEST' })).body.code, 'SPECIAL_ORDER_REPLACE_ALLOCATED');
  await query("UPDATE dispatch_so_po_allocations SET status='cancelled' WHERE id=$1", [allocation]);
  const linesBefore = await remoteLines(d);

  const replaced = await call('scm', 'POST', path, { expectedRevision: d.revision, purchaseOrderRef: newRef.toLowerCase(), reason: '  Vendor re-issued the PO  ' });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const saved = replaced.body;
  assert.equal(saved.purchaseOrderId, d.purchaseOrderId + 2); assert.equal(saved.purchaseOrderRef, newRef);
  assert.equal(saved.purchaseOrderCustomLinkage, true); assert.equal(saved.purchaseOrderSentToVendorAt, null);
  assert.equal(saved.attention, false); assert.equal(saved.revision, d.revision + 1);
  assert.equal(saved.salesOrderId, d.salesOrderId); assert.equal(saved.stage, 'confirmed');
  assert.deepEqual(await remoteLines(d), { sales_order: linesBefore.sales_order, purchase_order: null });
  assert.equal(Number((await query('SELECT purchase_order_netsuite_id FROM sales_special_stock_handoffs WHERE request_id=$1', [d.id])).rows[0].purchase_order_netsuite_id), saved.purchaseOrderId);
  const event = saved.events.find(row => row.eventType === 'special_purchase_order_replaced');
  assert.deepEqual([event.details.previous.ref, event.details.replacement.ref, event.details.reason, event.actorId], [d.purchaseOrderRef, newRef, 'Vendor re-issued the PO', users.scm.id]);
  const salesView = await call('sales', 'GET', `/api/sales/special-stock-requests/${d.id}`);
  assert.ok(salesView.body.events.some(row => row.eventType === 'special_purchase_order_replaced'), 'Sales sees the PO replacement.');
  assert.equal((await call('scm', 'POST', path, { expectedRevision: saved.revision, purchaseOrderRef: d.purchaseOrderRef, reason: 'TEST' })).body.code, 'SPECIAL_ORDER_REPLACE_INACTIVE');
});

test('Sales replaces the SO; SO and PO become independent and a direct route is selected again', async () => {
  let d = await fixture('mbt_delivery');
  await handoff(d, 'direct', 'ready');
  d = await load(d);
  const path = `/api/sales/special-stock-requests/${d.id}/sales-order/replace`;
  const newRef = 'TEST-VPR-SO-NEW-' + d.id;
  const forbidden = await call('otherSales', 'POST', path, { expectedRevision: d.revision, salesOrderRef: newRef, reason: 'TEST' });
  assert.equal(forbidden.status, 403); assert.equal(forbidden.body.code, 'SPECIAL_CASE_STORE_FORBIDDEN');
  const linesBefore = await remoteLines(d);
  const replaced = await call('sales', 'POST', path, { expectedRevision: d.revision, salesOrderRef: newRef, reason: 'Customer account corrected' });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const saved = replaced.body;
  assert.equal(saved.salesOrderId, d.salesOrderId + 2); assert.equal(saved.salesOrderRef, newRef);
  assert.equal(saved.salesOrderSource, 'manual_link'); assert.equal(saved.purchaseOrderCustomLinkage, true);
  assert.equal(saved.netsuiteCustomerName, 'TEST Replacement Customer'); assert.equal(saved.purchaseOrderId, d.purchaseOrderId);
  assert.equal(saved.handoffRoute, null);
  assert.deepEqual(await remoteLines(d), { sales_order: null, purchase_order: linesBefore.purchase_order });
  const row = (await query('SELECT route,status,sales_order_netsuite_id FROM sales_special_stock_handoffs WHERE request_id=$1', [d.id])).rows[0];
  assert.deepEqual([row.route, row.status, Number(row.sales_order_netsuite_id)], [null, 'waiting_route', saved.salesOrderId]);
  const event = saved.events.find(item => item.eventType === 'special_sales_order_replaced');
  assert.deepEqual([event.details.previous.ref, event.details.replacement.ref, event.details.reason, event.details.routeReset], [d.salesOrderRef, newRef, 'Customer account corrected', true]);
});

test('completed or closed requests cannot replace their orders', async () => {
  const d = await fixture('vendor_pickup');
  await query("UPDATE sales_orders SET status='G',status_text='Sales Order : Billed' WHERE netsuite_id=$1", [d.salesOrderId]);
  const completed = await load(d); assert.equal(completed.stage, 'completed');
  const so = await call('sales', 'POST', `/api/sales/special-stock-requests/${d.id}/sales-order/replace`,
    { expectedRevision: completed.revision, salesOrderRef: 'TEST-VPR-SO-NEW-' + d.id, reason: 'TEST' });
  assert.equal(so.status, 409); assert.equal(so.body.code, 'SPECIAL_CASE_CLOSED');
  const po = await call('scm', 'POST', `/api/scm/special-stock-requests/${d.id}/purchase-order/replace`,
    { expectedRevision: completed.revision, purchaseOrderRef: 'TEST-VPR-PO-NEW-' + d.id, reason: 'TEST' });
  assert.equal(po.status, 409); assert.equal(po.body.code, 'SPECIAL_CASE_CLOSED');
});

test('nightly refresh selects open Special vendor pickups and reports those the refreshed SO completes', async () => {
  const open = await fixture('vendor_pickup'), yard = await fixture('yard_pickup'), closed = await fixture('vendor_pickup');
  await query("UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1", [closed.id]);
  const ids = await listOpenSpecialVendorPickupRequestIds();
  assert.ok(ids.includes(open.id)); assert.ok(!ids.includes(yard.id)); assert.ok(!ids.includes(closed.id));
  const calls = [];
  const result = await refreshOpenSpecialVendorPickupOrders({ listIds: async () => [open.id],
    refresh: async (details, options) => {
      calls.push({ ids: details.map(detail => detail.id), options });
      await query("UPDATE sales_orders SET status='G',status_text='Sales Order : Billed' WHERE netsuite_id=$1", [details[0].salesOrderId]);
      return { attempted: 2, updated: 1, failed: 0 };
    } });
  assert.deepEqual(calls, [{ ids: [open.id], options: { force: true } }]);
  assert.deepEqual(result, { requests: 1, attempted: 2, updated: 1, failed: 0, completedRequestIds: [open.id] });
  assert.ok(!(await listOpenSpecialVendorPickupRequestIds()).includes(open.id));
  const errors = [];
  const failed = await refreshOpenSpecialVendorPickupOrders({ listIds: async () => [yard.id], refresh: async () => { throw new Error('NetSuite unavailable'); },
    logger: { error: (...args) => errors.push(args) } });
  assert.deepEqual([failed.failed, failed.completedRequestIds, errors.length], [1, [], 1]);
  const disabled = await refreshOpenSpecialVendorPickupOrders({ listIds: async () => [yard.id] });
  assert.deepEqual([disabled.attempted, disabled.failed], [0, 0], 'Direct NetSuite access is disabled in tests.');
});
