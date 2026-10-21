/* global AbortController, TextDecoder */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import { app, processNetSuiteOrderWebhook } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, closeDb, withTransaction } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';

const users = {}, caseIds = [], orderIds = [];
let server, base, flag, sequence = 0;
const context = () => ({ operatorId: users.sales.id, authorizedStoreLocationIds: [1] });
const detail = id => repo.getSpecialStockCase(id, { audience: 'scm', dispatchPlans: [] });
const lines = async id => (await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id', [id])).rows;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
  flag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  for (const role of ['sales', 'scm', 'admin']) {
    const username = 'shared-orders-' + role + '-' + crypto.randomUUID(), password = crypto.randomUUID();
    users[role] = await createOperator({ username, password, displayName: 'TEST ' + role, role, roles: [role], yardLocationIds: [1] });
    const result = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(result.status, 200);
    users[role].token = (await result.json()).token;
  }
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
});
after(async () => {
  try {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [caseIds]);
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])', [orderIds]);
    await query('DELETE FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[])', [orderIds]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])', [orderIds]);
    await query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])', [orderIds]);
    for (const user of Object.values(users)) {
      await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1', [user.id]);
      await query('DELETE FROM operators WHERE id=$1', [user.id]);
    }
    if (flag !== undefined) { await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [flag]); }
  } finally { await closeDb(); }
});
async function newCase(storeLocationId = 1) {
  const d = await repo.createSpecialStockCase({ storeLocationId, inquiryDate: '2099-01-01',
    customerName: 'TEST Shared orders', vendorId: 331, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
    lines: [{ productName: 'TEST Material ' + sequence, quantity: 12, uom: 'PCS', rate: 4, requiredDate: '2099-02-01' }] },
  { ...context(), authorizedStoreLocationIds: [storeLocationId] });
  caseIds.push(d.id);
  return d;
}
async function fixture(count = 2) {
  const soId = 88997000 + (++sequence) * 2, poId = soId + 1;
  const soRef = 'TEST-SHARED-SO-' + sequence, poRef = 'TEST-SHARED-PO-' + sequence;
  orderIds.push(soId, poId);
  await query("INSERT INTO sales_orders(netsuite_id,tranid,order_location_id,status,status_text,netsuite_active) VALUES($1,$2,1,'B','Pending Fulfillment',true)", [soId, soRef]);
  await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,970101,2055,'MBBS-Special Order','Shared material',100,'PC',true)", [soId]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status,status_text,netsuite_active) VALUES($1,$2,331,1,'B','Pending Receipt',true)", [poId, poRef]);
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,970201,2055,'MBBS-Special Order','Shared material',100,'PC',true)", [poId]);
  const cases = [];
  for (let index = 0; index < count; index++) { cases.push(await newCase()); }
  return { soId, poId, soRef, poRef, cases };
}
const linkSo = (d, f, extra = {}) => repo.linkSpecialSalesOrder(d.id, { expectedRevision: d.revision, salesOrderRef: f.soRef, ...extra }, context());
const linkPo = (d, f, extra = {}) => repo.linkSpecialPurchaseOrder(d.id, { expectedRevision: d.revision, purchaseOrderRef: f.poRef, customLinkage: true, ...extra }, { operatorId: users.scm.id });
async function pair(d, f) { return linkPo(await linkSo(d, f), f); }
async function call(d, f, kind, role) {
  const result = await fetch(`${base}/api/${kind === 'sales' ? 'sales' : 'scm'}/special-stock-requests/${d.id}/${kind}-order/link`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(users[role]?.token ? { authorization: 'Bearer ' + users[role].token } : {}) },
    body: JSON.stringify(kind === 'sales' ? { expectedRevision: d.revision, salesOrderRef: f.soRef }
      : { expectedRevision: d.revision, purchaseOrderRef: f.poRef, customLinkage: true })
  });
  return { status: result.status, body: await result.json() };
}

test('Special cases share an existing SO and preserve separate lines and audit events', async () => {
  const f = await fixture();
  const snapshots = await Promise.all(f.cases.map(d => lines(d.id)));
  for (const [index, d] of f.cases.entries()) {
    const linked = await linkSo(d, f);
    assert.equal(linked.salesOrderId, f.soId);
    assert.equal(linked.revision, d.revision + 1);
    assert.deepEqual(await lines(d.id), snapshots[index]);
    assert.equal(linked.events.filter(event => event.eventType === 'special_sales_order_linked').length, 1);
  }
});
test('Special cases share an existing PO before linking an SO', async () => {
  const f = await fixture();
  for (const d of f.cases) {
    const linked = await linkPo(d, f);
    assert.equal(linked.purchaseOrderId, f.poId);
    assert.equal(linked.salesOrderId, null);
    assert.equal(linked.events.filter(event => event.eventType === 'special_purchase_order_linked').length, 1);
  }
});
test('concurrent SO and PO links by separate cases all commit', async () => {
  const f = await fixture(3);
  const sales = await Promise.all(f.cases.map(d => linkSo(d, f)));
  const purchase = await Promise.all(sales.map(d => linkPo(d, f)));
  assert.equal(purchase.length, 3);
  for (const d of purchase) { assert.equal(d.salesOrderId, f.soId); assert.equal(d.purchaseOrderId, f.poId); assert.ok(d.handoff); }
});
test('Sales and SCM HTTP routes allow a shared SO/PO pair', async () => {
  const f = await fixture();
  for (const d of f.cases) {
    const so = await call(d, f, 'sales', 'sales');
    assert.equal(so.status, 200, JSON.stringify(so.body));
    const po = await call(so.body, f, 'purchase', 'scm');
    assert.equal(po.status, 200, JSON.stringify(po.body));
    assert.equal(po.body.salesOrderId, f.soId); assert.equal(po.body.purchaseOrderId, f.poId);
  }
});
for (const kind of ['sales_order', 'purchase_order']) {
  test(`${kind} webhook reconciles all cases sharing the order`, async () => {
    const f = await fixture(3), linked = [];
    for (const d of f.cases) { linked.push(await pair(d, f)); }
    await query("UPDATE sales_orders SET status='A',status_text='Pending Approval' WHERE netsuite_id=$1", [f.soId]);
    await query("UPDATE purchase_orders SET status='A',status_text='Purchase Order : Pending Approval' WHERE netsuite_id=$1", [f.poId]);
    const result = await repo.reconcileSpecialOrderWebhook({ orderKind: kind, orderId: kind === 'sales_order' ? f.soId : f.poId });
    assert.equal(result.matched, true);
    assert.deepEqual(result.requestIds, linked.map(d => d.id).sort((a, b) => a - b));
    for (const d of linked) {
      const saved = await detail(d.id);
      assert.equal(saved.salesOrderApproved, false);
      assert.equal(saved.salesOrderStatus, 'Pending Approval');
      assert.equal(saved.purchaseOrderStatus, 'Purchase Order : Pending Approval');
      assert.equal(saved.revision, d.revision + 1);
      assert.equal(saved.events.filter(event => event.eventType === 'special_order_webhook_reconciled').length, 1);
    }
  });
}
test('a reconciliation mismatch affects only that case and does not skip other shared cases', async () => {
  const f = await fixture(3), linked = [];
  for (const d of f.cases) { linked.push(await pair(d, f)); }
  await query("UPDATE sales_special_stock_cases SET sales_order_source='standalone',purchase_order_custom_linkage=false WHERE request_id=$1", [linked[0].id]);
  await query("INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_rate) VALUES($1,'sales_order',true,2055,'MBBS-Special Order','Missing material',999,'PC',4)", [linked[0].id]);
  const result = await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: f.soId });
  assert.equal(result.attention, true);
  assert.equal((await detail(linked[0].id)).attention, true);
  for (const d of linked.slice(1)) { const saved = await detail(d.id); assert.equal(saved.attention, false); assert.equal(saved.revision, d.revision + 1); }
});
test('actual webhook processing audits and notifies every shared case', async () => {
  const f = await fixture(3), linked = [];
  for (const d of f.cases) { linked.push(await pair(d, f)); }
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 5000);
  let reader;
  try {
    const stream = await fetch(base + '/api/events?token=' + users.admin.token, { signal: abort.signal });
    assert.equal(stream.status, 200);
    reader = stream.body.getReader();
    const result = await processNetSuiteOrderWebhook({ id: f.poId, recordType: 'purchaseorder', tranid: f.poRef,
      status: 'A', statusText: 'Purchase Order : Pending Approval', entityId: 331, locationId: 1,
      lines: [{ lineUniqueKey: 970201, orderLine: 1, itemId: 2055, itemName: 'MBBS-Special Order',
        itemType: 'InvtPart', quantity: 100, unit: 'PC', locationId: 1 }] }, { scheduleDelayedStatus: false });
    const reconciled = result.results.filter(row => row.target === 'sales_special_stock_cases');
    assert.deepEqual(reconciled.map(row => row.requestId), linked.map(d => d.id));
    let text = '', notifications = [];
    while (notifications.length < linked.length) {
      const chunk = await reader.read(); assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
      notifications = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
        .filter(event => event.type === 'special-stock-request.updated' && event.payload.source === 'netsuite-webhook');
    }
    assert.deepEqual(notifications.map(event => event.payload.requestId), linked.map(d => d.id));
    const audit = (await query("SELECT details FROM delivery_audit_log WHERE action='netsuite.webhook.order' AND details->>'netsuiteOrderId'=$1 ORDER BY id DESC LIMIT 1", [String(f.poId)])).rows[0];
    assert.deepEqual(audit.details.results.filter(row => row.target === 'sales_special_stock_cases').map(row => row.requestId), linked.map(d => d.id));
  } finally { clearTimeout(timeout); abort.abort(); await reader?.cancel().catch(() => {}); }
});
test('sharing preserves per-case replacement guards and rejects stale concurrent updates', async () => {
  const f = await fixture(), other = await fixture(0), linked = await pair(f.cases[0], f);
  await assert.rejects(linkSo(linked, other), { code: 'SPECIAL_SO_ALREADY_LINKED' });
  await assert.rejects(linkPo(linked, other), { code: 'SPECIAL_PO_ALREADY_LINKED' });
  const initial = f.cases[1];
  const attempts = await Promise.allSettled([linkSo(initial, f), linkSo(initial, f)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.code === 'SPECIAL_REVISION_CONFLICT').length, 1);
  assert.equal((await detail(initial.id)).events.filter(event => event.eventType === 'special_sales_order_linked').length, 1);
});
test('shared links retain role authorization, yard scope, and order identity validation', async () => {
  const f = await fixture(), d = f.cases[0];
  assert.equal((await call(d, f, 'purchase', 'sales')).status, 403);
  assert.equal((await call(d, f, 'sales', null)).status, 401);
  await assert.rejects(repo.linkSpecialSalesOrder(d.id, { expectedRevision: d.revision, salesOrderRef: f.soRef },
    { ...context(), authorizedStoreLocationIds: [28] }), { code: 'SPECIAL_CASE_STORE_FORBIDDEN' });
  await assert.rejects(linkSo(d, f, { salesOrderId: f.soId + 99 }), { code: 'SPECIAL_SO_REFERENCE_MISMATCH' });
  await assert.rejects(linkPo(d, f, { purchaseOrderId: f.poId + 99 }), { code: 'SPECIAL_PO_REFERENCE_MISMATCH' });
  assert.equal((await detail(d.id)).salesOrderId, null); assert.equal((await detail(d.id)).purchaseOrderId, null);
});
test('operation IDs remain unique when cases share an SO or PO', async () => {
  const f = await fixture(), operationId = crypto.randomUUID();
  const first = await linkSo(f.cases[0], f, { operationId });
  await assert.rejects(linkSo(f.cases[1], f, { operationId }), { code: 'SPECIAL_REMOTE_OPERATION_BUSY' });
  const second = await linkSo(f.cases[1], f, { operationId: crypto.randomUUID() });
  await linkPo(first, f, { operationId });
  await assert.rejects(linkPo(second, f, { operationId }), { code: 'SPECIAL_REMOTE_OPERATION_BUSY' });
  assert.equal((await detail(second.id)).purchaseOrderId, null);
});
test('property: every shared case reconciles exactly once regardless of count or link order', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 5 }), fc.boolean(), async (count, reverse) => {
    const f = await fixture(count), ordered = reverse ? [...f.cases].reverse() : f.cases;
    const linked = [];
    for (const d of ordered) { linked.push(await pair(d, f)); }
    await repo.reconcileSpecialOrderWebhook({ orderKind: 'purchase_order', orderId: f.poId });
    for (const d of linked) {
      const saved = await detail(d.id);
      assert.equal(saved.revision, d.revision + 1);
      assert.equal(saved.events.filter(event => event.eventType === 'special_order_webhook_reconciled').length, 1);
      assert.equal(saved.salesOrderId, f.soId); assert.equal(saved.purchaseOrderId, f.poId);
    }
  }), { seed: 20261009, numRuns: 5 });
});
test('unmatched and single-case webhook results retain existing fields', async () => {
  assert.deepEqual(await repo.reconcileSpecialOrderWebhook({ orderKind: 'invalid', orderId: 1 }), { matched: false });
  assert.deepEqual(await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: 88999999 }), { matched: false });
  const f = await fixture(1); await pair(f.cases[0], f);
  const result = await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: f.soId });
  assert.deepEqual(result, { matched: true, requestId: f.cases[0].id, attention: false, remotelyReconciled: false });
});
test('migration lookup indexes permit sharing while retaining operation uniqueness', async () => {
  const indexes = (await query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='sales_special_stock_cases' AND indexname IN ('idx_sales_special_stock_so_owner','idx_sales_special_stock_po_owner','idx_sales_special_stock_so_operation','idx_sales_special_stock_po_operation')")).rows;
  assert.equal(indexes.length, 4);
  for (const index of indexes) { assert.equal(index.indexdef.includes('CREATE UNIQUE INDEX'), index.indexname.endsWith('_operation')); }
  await withTransaction(async () => {
    const before = (await query('SELECT request_id,sales_order_netsuite_id,purchase_order_netsuite_id FROM sales_special_stock_cases ORDER BY request_id')).rows;
    await query('SAVEPOINT indexes_rehearsal');
    await query('DROP INDEX idx_sales_special_stock_so_owner; DROP INDEX idx_sales_special_stock_po_owner;');
    await query('ROLLBACK TO SAVEPOINT indexes_rehearsal');
    assert.deepEqual((await query('SELECT request_id,sales_order_netsuite_id,purchase_order_netsuite_id FROM sales_special_stock_cases ORDER BY request_id')).rows, before);
  });
});
