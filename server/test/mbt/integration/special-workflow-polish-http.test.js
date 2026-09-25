import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { createOperator } from '../../../src/auth-repository.js';
import { query, pool, closeDb } from '../../../src/db.js';
import * as repository from '../../../src/special-stock-request-repository.js';
import { app } from '../../../src/server.js';

const run = crypto.randomUUID().replaceAll('-', '');
const gate = 'special_stock_request_test_skip_orders';
const tokens = {}, ids = [], users = [];
let server, base, original, originalWorkflow, context;
async function request(path, { role, body, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}
async function draft() {
  let detail = await repository.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 8899310,
    customerName: 'TEST Polish HTTP', vendorId: 8899200, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
    lines: [{ productName: 'TEST product', quantity: 2, uom: 'PLT', rate: 50, requiredDate: '2099-02-01' }] }, context);
  ids.push(detail.id);
  detail = await repository.respondSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision,
    supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 8899200, vendorName: 'TEST Vendor', vendorYard: 'TEST yard' }, context);
  detail = await repository.decideSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, decision: 'accepted' }, context);
  return repository.saveSpecialSalesOrderDraft(detail.id, { expectedRevision: detail.revision, customerId: 8899310,
    operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', palletTotal: 0,
    materialLines: [{ caseLineId: detail.lines[0].id, itemId: 2055, description: 'TEST product', quantity: 20, packageQuantity: 2, conversionToPc: 10, uom: 'PC', rate: 50 }] }, context);
}
const endpoint = (detail, order = 'sales') => `/api/${order === 'sales' ? 'sales' : 'scm'}/special-stock-requests/${detail.id}/${order}-order/skip`;
const poLines = detail => detail.purchaseOrderLines.map(line => ({ caseLineId: line.caseLineId, description: 'TEST PO', quantity: 2, uom: 'PC', unitPurchaseCost: 4 }));

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
  original = (await query('SELECT enabled FROM mbt_feature_flags WHERE flag_key=$1', [gate])).rows[0].enabled;
  originalWorkflow = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ($1,'special_stock_request_workflow')", [gate]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899310,'TEST-POLISH','TEST Polish HTTP','TEST Polish HTTP','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
  for (const [name, role, yards] of [['sales','sales',[1]],['other','sales',[28]],['scm','scm',[]],['dispatch','dispatcher',[]]]) {
    const username = `polish-${name}-${run}`;
    await createOperator({ username, displayName: `TEST ${name}`, password: 'test-polish-isolated-only', role, roles: [role], yardLocationIds: yards });
    users.push(username);
  }
  context = { operatorId: (await query('SELECT id FROM operators WHERE username=$1', [users[0]])).rows[0].id, authorizedStoreLocationIds: [1] };
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['sales','other','scm','dispatch']) {
    const login = await request('/api/auth/login', { body: { username: `polish-${name}-${run}`, password: 'test-polish-isolated-only' } });
    assert.equal(login.status, 200);
    tokens[name] = login.payload.token;
  }
});
after(async () => {
  if (original !== undefined) await query('UPDATE mbt_feature_flags SET enabled=$2 WHERE flag_key=$1', [gate, original]);
  if (originalWorkflow !== undefined) await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [originalWorkflow]);
  if (server) await new Promise(resolve => server.close(resolve));
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [ids]);
  await query('DELETE FROM operators WHERE username=ANY($1::text[])', [users]);
  await closeDb();
});

test('skip HTTP routes require authentication, correct role, gate and Sales yard access', async () => {
  const detail = await draft(), body = { expectedRevision: detail.revision };
  assert.equal((await request(endpoint(detail), { body })).status, 401);
  assert.equal((await request(endpoint(detail), { role: 'scm', body })).status, 403);
  assert.equal((await request(endpoint(detail, 'purchase'), { role: 'sales', body })).status, 403);
  assert.equal((await request(endpoint(detail, 'purchase'), { role: 'dispatch', body })).status, 403);
  assert.equal((await request(endpoint(detail), { role: 'other', body })).payload.code, 'SPECIAL_CASE_STORE_FORBIDDEN');
  await query('UPDATE mbt_feature_flags SET enabled=false WHERE flag_key=$1', [gate]);
  assert.equal((await request('/api/sales/special-stock-requests/policy', { role: 'sales' })).payload.testSkipOrdersEnabled, false);
  assert.equal((await request(endpoint(detail), { role: 'sales', body })).payload.code, 'SPECIAL_TEST_SKIP_DISABLED');
  assert.equal((await request(endpoint(detail, 'purchase'), { role: 'scm', body })).payload.code, 'SPECIAL_TEST_SKIP_DISABLED');
  await query('UPDATE mbt_feature_flags SET enabled=true WHERE flag_key=$1', [gate]);
});

test('duplicate concurrent SO and PO skips each commit once and preserve role-owned order kind', async () => {
  let detail = await draft();
  const so = await Promise.all([1, 2].map(() => request(endpoint(detail), { role: 'sales', body: { expectedRevision: detail.revision, orderKind: 'purchase_order' } })));
  assert.deepEqual(so.map(row => row.status).sort(), [200,409]);
  detail = so.find(row => row.status === 200).payload;
  assert.equal(detail.salesOrderSkipped, true);
  assert.equal(detail.purchaseOrderSkipped, false);
  assert.equal(detail.salesOrderId, null);
  assert.equal(detail.events.filter(event => event.eventType === 'special_sales_order_creation_skipped').length, 1);
  const full = await repository.getSpecialStockCase(detail.id);
  const po = await Promise.all([1, 2].map(() => request(endpoint(detail, 'purchase'), { role: 'scm', body: { expectedRevision: detail.revision, lines: poLines(full) } })));
  assert.deepEqual(po.map(row => row.status).sort(), [200,409]);
  const result = po.find(row => row.status === 200).payload;
  assert.equal(result.stage, 'dispatch_arrangement');
  assert.equal(result.purchaseOrderId, null);
  assert.equal(result.events.filter(event => event.eventType === 'special_purchase_order_creation_skipped').length, 1);
  assert.equal(result.handoff, null);
});

test('gate disable wins before a waiting skip transaction without advancing the request', async () => {
  const detail = await draft(), client = await pool.connect();
  let pending;
  try {
    await client.query('BEGIN');
    await client.query('UPDATE mbt_feature_flags SET enabled=false WHERE flag_key=$1', [gate]);
    pending = request(endpoint(detail), { role: 'sales', body: { expectedRevision: detail.revision } });
    let waiting = false;
    for (let attempt=0; attempt<100 && !waiting; attempt++) {
      waiting = Boolean((await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT flag_key, enabled FROM mbt_feature_flags%' LIMIT 1")).rowCount);
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, 'Skip must reach the transactional gate lock');
    await client.query('COMMIT');
    assert.equal((await pending).payload.code, 'SPECIAL_TEST_SKIP_DISABLED');
    const current = await repository.getSpecialStockCase(detail.id);
    assert.equal(current.revision, detail.revision);
    assert.equal(current.salesOrderSkipped, false);
  } finally {
    await client.query('ROLLBACK'); client.release();
    if (pending) await pending;
    await query('UPDATE mbt_feature_flags SET enabled=true WHERE flag_key=$1', [gate]);
  }
});

test('real creation claim and test skip cannot both acquire the same request revision', async () => {
  const detail = await draft();
  const results = await Promise.allSettled([
    repository.claimSpecialOrderOperation(detail.id, { expectedRevision: detail.revision, orderKind: 'sales_order', operationId: crypto.randomUUID() }, context),
    repository.skipSpecialOrderCreation(detail.id, { expectedRevision: detail.revision, orderKind: 'sales_order' }, context)
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const current = await repository.getSpecialStockCase(detail.id);
  assert.equal(current.salesOrderSkipped && current.salesOrderOperationStatus === 'creating', false);
});
