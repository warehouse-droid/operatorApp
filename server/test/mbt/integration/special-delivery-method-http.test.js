import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, closeDb } from '../../../src/db.js';
import { createSpecialStockCase, getSpecialStockCase } from '../../../src/special-stock-request-repository.js';
const sessions = {}, users = [], cases = [], run = crypto.randomUUID(), password = crypto.randomUUID();
let server, base, flag, detail;
const request = (path, role, body) => fetch(base + path, { method: body ? 'POST' : 'GET',
  headers: { ...(role ? { Authorization: `Bearer ${sessions[role].token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined });
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1'); assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
  flag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  for (const role of ['sales', 'scm', 'scm_other', 'dispatcher', 'admin', 'operator']) {
    const username = `method-change-${role}-${run}`; users.push(username);
    await createOperator({ username, displayName: 'TEST', password, role: role === 'scm_other' ? 'scm' : role, roles: [role === 'scm_other' ? 'scm' : role], yardLocationIds: [1] });
    const response = await request('/api/auth/login', null, { username, password }); assert.equal(response.status, 200); sessions[role] = await response.json();
  }
  detail = await createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST', vendorName: 'TEST', fulfillmentMethod: 'vendor_pickup',
    lines: [{ productName: 'TEST', quantity: 3, uom: 'SQFT', rate: 42, requiredDate: '2099-02-01' }] }, { operatorId: sessions.sales.operator.id, authorizedStoreLocationIds: [1] });
  cases.push(detail.id);
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active,order_location_id,delivery_method_id,sales_order_type) VALUES(8899961,'TEST-HTTP-SO','B','Pending Fulfillment',true,1,1,'Pickup')");
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,status,status_text,netsuite_active) VALUES(8899962,'TEST-HTTP-PO','TEST-HTTP-REF','B','Pending Receipt',true)");
  await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899961,sales_order_ref='TEST-HTTP-SO',sales_order_approved=true,purchase_order_netsuite_id=8899962,purchase_order_ref='TEST-HTTP-PO' WHERE request_id=$1", [detail.id]);
  await query("UPDATE sales_special_stock_lines SET supply_status='in_stock',sales_decision='accepted' WHERE request_id=$1", [detail.id]);
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [cases]);
  await query('DELETE FROM operators WHERE username=ANY($1::text[])', [users]);
  await query('DELETE FROM sales_orders WHERE netsuite_id=8899961'); await query('DELETE FROM purchase_orders WHERE netsuite_id=8899962');
  if (flag !== undefined) await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [flag]);
  await closeDb();
});
test('team delivery alert routes enforce authentication and existing role permissions without caching', async () => {
  for (const audience of ['scm', 'dispatch']) {
    const path = `/api/${audience}/special-stock-requests/delivery-method-alerts`;
    assert.equal((await request(path)).status, 401);
    for (const role of ['sales', 'operator']) { assert.equal((await request(path, role)).status, 403); }
    const allowed = audience === 'scm' ? ['scm', 'scm_other', 'admin'] : ['dispatcher', 'admin'];
    for (const role of allowed) {
      const response = await request(path, role); assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.deepEqual(await response.json(), { alerts: [] });
    }
    const ack = path + '/999/ack';
    assert.equal((await request(ack, null, {})).status, 401); assert.equal((await request(ack, 'sales', {})).status, 403);
  }
});
test('real HTTP pickup change publishes both team notices, and acknowledging SCM leaves Dispatch unread', async () => {
  const response = await request(`/api/sales/special-stock-requests/${detail.id}/fulfillment`, 'sales', { expectedRevision: detail.revision, fulfillmentMethod: 'yard_pickup' });
  assert.equal(response.status, 200); detail = await response.json(); assert.equal(detail.fulfillmentMethod, 'yard_pickup');
  const scmPath = '/api/scm/special-stock-requests/delivery-method-alerts', dispatchPath = '/api/dispatch/special-stock-requests/delivery-method-alerts';
  const a = await (await request(scmPath, 'scm')).json(), b = await (await request(dispatchPath, 'dispatcher')).json();
  assert.equal(a.alerts.length, 1); assert.equal(b.alerts.length, 1); assert.equal(a.alerts[0].id, b.alerts[0].id);
  assert.equal(a.alerts[0].purchaseOrderReference, 'TEST-HTTP-REF'); assert.equal(a.alerts[0].yardName, '3445');
  const before = await getSpecialStockCase(detail.id, { audience: 'scm' });
  const ack = await request(`${scmPath}/${a.alerts[0].id}/ack`, 'scm', {}); assert.equal(ack.status, 200); assert.deepEqual(await ack.json(), { acknowledged: true });
  assert.deepEqual(await (await request(scmPath, 'scm')).json(), { alerts: [] });
  assert.equal((await (await request(dispatchPath, 'dispatcher')).json()).alerts.length, 1);
  assert.equal((await (await request(scmPath, 'scm_other')).json()).alerts.length, 1);
  assert.deepEqual(await getSpecialStockCase(detail.id, { audience: 'scm' }), before);
  assert.equal((await request(`${dispatchPath}/${b.alerts[0].id}/ack`, 'scm', {})).status, 403);
  const dispatchAck = await request(`${dispatchPath}/${b.alerts[0].id}/ack`, 'dispatcher', {});
  assert.equal(dispatchAck.status, 200); assert.deepEqual(await dispatchAck.json(), { acknowledged: true });
  assert.deepEqual(await (await request(dispatchPath, 'dispatcher')).json(), { alerts: [] });
  assert.equal((await (await request(scmPath, 'admin')).json()).alerts.length, 1);
});
test('twenty simultaneous acknowledgements of one notice commit once without changing the request', async () => {
  const path = '/api/scm/special-stock-requests/delivery-method-alerts';
  const { alerts } = await (await request(path, 'admin')).json(); assert.equal(alerts.length, 1);
  const before = await getSpecialStockCase(detail.id, { audience: 'scm' });
  const responses = await Promise.all(Array.from({ length: 20 }, () => request(`${path}/${alerts[0].id}/ack`, 'admin', {})));
  for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { acknowledged: true }); }
  assert.deepEqual(await (await request(path, 'admin')).json(), { alerts: [] });
  const count = (await query("SELECT count(*)::int AS n FROM special_delivery_method_alert_receipts WHERE event_id=$1 AND operator_id=$2 AND audience='scm'", [alerts[0].id, sessions.admin.operator.id])).rows[0].n;
  assert.equal(count, 1); assert.deepEqual(await getSpecialStockCase(detail.id, { audience: 'scm' }), before);
});
test('alert routes respect the Special workflow gate and reject malformed notice IDs', async () => {
  const path = '/api/scm/special-stock-requests/delivery-method-alerts';
  for (const id of ['0', '-1', '1.5', 'bad']) { assert.equal((await request(`${path}/${id}/ack`, 'scm', {})).status, 400); }
  assert.equal((await request(`${path}/999999999/ack`, 'scm', {})).status, 404);
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'");
  try { assert.equal((await request(path, 'scm')).status, 404); }
  finally { await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'"); }
});
