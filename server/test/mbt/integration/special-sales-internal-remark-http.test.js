import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, closeDb, withTransaction } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { buildSpecialQuote } from '../../../src/special-stock-documents.js';
const users = {}, cases = [], run = randomUUID(), secret = 'Sales only document exclusion\n内部 <remark>';
let server, base, flag, originalFetch, remoteCalls = 0;
const context = () => ({ operatorId: users.sales.id, authorizedStoreLocationIds: [1] });
async function call(path, role = 'sales', body, method = body ? 'PUT' : 'GET') {
  const response = await fetch(base + path, { method, headers: { ...(users[role]?.token ? { authorization: 'Bearer ' + users[role].token } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function draft(extra = {}) {
  const result = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Customer',
    vendorId: 330, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup', remarks: 'Customer Note',
    lines: [{ productName: 'Stone', quantity: 2, uom: 'PCS', rate: 10, requiredDate: '2099-02-01' }], ...extra }, context());
  cases.push(result.id); return result;
}
const path = id => `/api/sales/special-stock-requests/${id}/internal-remark`;
const audit = async id => (await query("SELECT * FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_sales_internal_remark_updated' ORDER BY id", [id])).rows;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-updates-db-20261002');
  try { await query(await readFile('migrations/259_special_sales_internal_remark.sql', 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  flag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { if (String(url).startsWith(base + '/')) return originalFetch(url, options); remoteCalls++; throw new Error('Internal remarks must never call external services'); };
  for (const [name, role, yards] of [['sales', 'sales', [1]], ['other', 'sales', [28]], ['scm', 'scm', []], ['dispatch', 'dispatcher', []]]) {
    const username = `internal-remark-${name}-${run}`, password = randomUUID();
    users[name] = await createOperator({ username, displayName: `TEST ${name}`, password, role, roles: [role], yardLocationIds: yards });
    const login = await call('/api/auth/login', null, { username, password }, 'POST'); assert.equal(login.status, 200); users[name].token = login.body.token;
  }
});
after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [cases]);
  for (const user of Object.values(users)) await query('DELETE FROM operators WHERE id=$1', [user.id]);
  if (flag !== undefined) await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [flag]);
  await closeDb(); assert.equal(remoteCalls, 0);
});
test('New requests persist an internal remark and expose it only to Sales with a blank default for existing requests', async () => {
  const d = await draft({ salesInternalRemark: secret }); assert.equal(d.salesInternalRemark, secret);
  for (const audience of ['sales', 'scm']) {
    const response = await call(`/api/${audience}/special-stock-requests/${d.id}`, audience);
    assert.equal(response.status, 200);
    if (audience === 'sales') assert.equal(response.body.salesInternalRemark, secret);
    else { assert.equal(response.body.salesInternalRemark, undefined); assert.ok(!JSON.stringify(response.body).includes('Sales only document exclusion')); }
  }
  assert.equal((await draft()).salesInternalRemark, '');
  assert.ok(!JSON.stringify(buildSpecialQuote(d, { name: 'TEST MBBS', taxBps: 1300 })).includes('Sales only document exclusion'));
});
test('Header saves both notes atomically without resetting stock checks; older clients preserve the internal remark', async () => {
  const d = await draft(), before = (await call(`/api/sales/special-stock-requests/${d.id}`)).body;
  let result = await call(`/api/sales/special-stock-requests/${d.id}/header`, 'sales', { expectedRevision: d.revision, remarks: 'New Note', salesInternalRemark: secret });
  assert.equal(result.status, 200); assert.equal(result.body.salesInternalRemark, secret); assert.equal(result.body.remarks, 'New Note');
  assert.equal(result.body.revision, d.revision + 1); assert.equal(result.body.stage, d.stage); assert.deepEqual(result.body.lines, before.lines);
  const scm = await call(`/api/scm/special-stock-requests/${d.id}`, 'scm');
  assert.equal(scm.body.salesInternalRemark, undefined); assert.ok(!JSON.stringify(scm.body).includes('Sales only document exclusion'));
  assert.equal(scm.body.events.some(event => event.eventType === 'special_sales_internal_remark_updated'), false);
  const scmList = await call('/api/scm/special-stock-requests?search=' + d.requestRef, 'scm');
  assert.ok(!JSON.stringify(scmList.body).includes('Sales only document exclusion'));
  const event = (await audit(d.id))[0]; assert.equal(event.actor_id, users.sales.id); assert.equal(event.audience, 'sales');
  assert.equal(event.details.after.salesInternalRemark, secret);
  result = await call(`/api/sales/special-stock-requests/${d.id}/header`, 'sales', { expectedRevision: result.body.revision, remarks: 'Second Note' });
  assert.equal(result.body.salesInternalRemark, secret);
  const revision = result.body.revision;
  result = await call(path(d.id), 'sales', { expectedRevision: revision, salesInternalRemark: secret });
  assert.equal(result.status, 200); assert.equal(result.body.revision, revision); assert.equal((await audit(d.id)).length, 1);
  result = await call(path(d.id), 'sales', { expectedRevision: revision, salesInternalRemark: '' });
  assert.equal(result.body.salesInternalRemark, ''); assert.equal(result.body.remarks, 'Second Note');
});
test('Internal remarks can change after order creation and during Pending Update, and remain readable after closure', async () => {
  const d = await draft();
  await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=990000001,sales_order_ref='TEST-SO',purchase_order_netsuite_id=990000002,purchase_order_ref='TEST-PO',information_request='{" + '"status":"pending","question":"Size?"' + "}'::jsonb WHERE request_id=$1", [d.id]);
  const before = (await call(`/api/sales/special-stock-requests/${d.id}`)).body, result = await call(path(d.id), 'sales', { expectedRevision: before.revision, salesInternalRemark: secret });
  assert.equal(result.status, 200); assert.equal(result.body.salesInternalRemark, secret); assert.equal(result.body.stage, before.stage);
  assert.equal(result.body.salesOrderId, before.salesOrderId); assert.equal(result.body.purchaseOrderId, before.purchaseOrderId); assert.deepEqual(result.body.lines, before.lines);
  await query("UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1", [d.id]);
  assert.equal((await call(path(d.id), 'sales', { expectedRevision: result.body.revision, salesInternalRemark: 'changed' })).status, 409);
  assert.equal((await call(`/api/sales/special-stock-requests/${d.id}`)).body.salesInternalRemark, secret);
});
test('Save endpoint enforces Sales role, yard scope, flag, validation and optimistic concurrency with one audit', async () => {
  const d = await draft(), body = { expectedRevision: d.revision, salesInternalRemark: secret, operatorId: users.scm.id };
  assert.equal((await call(path(d.id), null, body)).status, 401);
  for (const role of ['scm', 'dispatch']) assert.equal((await call(path(d.id), role, body)).status, 403);
  assert.equal((await call(path(d.id), 'other', body)).body.code, 'SPECIAL_CASE_STORE_FORBIDDEN');
  for (const value of [null, 5, {}, 'x'.repeat(8001), '\0']) assert.equal((await call(path(d.id), 'sales', { ...body, salesInternalRemark: value })).status, 400);
  assert.equal((await call(path(d.id), 'sales', { salesInternalRemark: secret })).status, 400);
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'");
  assert.equal((await call(path(d.id), 'sales', body)).status, 404);
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  const results = await Promise.all([call(path(d.id), 'sales', body), call(path(d.id), 'sales', body)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const saved = await repo.getSpecialStockCase(d.id); assert.equal(saved.revision, d.revision + 1);
  assert.equal(saved.status, d.status); assert.equal(saved.stage, d.stage);
  assert.equal((await audit(d.id)).length, 1); assert.equal((await audit(d.id))[0].actor_id, users.sales.id);
});
test('Migration is additive and repeatable, preserves data, and rolls back with the transaction', async () => {
  const sql = await readFile('migrations/259_special_sales_internal_remark.sql', 'utf8'), d = await draft({ salesInternalRemark: secret });
  const rollback = new Error('rollback rehearsal');
  await assert.rejects(withTransaction(async () => {
    await query(sql); await query(sql);
    assert.equal((await repo.getSpecialStockCase(d.id, { audience: 'sales' })).salesInternalRemark, secret);
    await query("UPDATE sales_special_stock_cases SET sales_internal_remark='temporary' WHERE request_id=$1", [d.id]); throw rollback;
  }), error => error === rollback);
  assert.equal((await repo.getSpecialStockCase(d.id, { audience: 'sales' })).salesInternalRemark, secret);
});
