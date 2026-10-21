import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, closeDb } from '../../../src/db.js';
import { createSpecialStockCase, getSpecialStockCase } from '../../../src/special-stock-request-repository.js';
const sessions = {}, users = [], cases = [], run = randomUUID(), password = randomUUID();
let server, base, flag;
async function request(path, user, body) {
  const result = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
    ...(user ? { Authorization: `Bearer ${sessions[user].token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: result.status, body: await result.json() };
}
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-updates-db-20261002');
  await query(await readFile('migrations/258_special_stock_information.sql', 'utf8'));
  flag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, role, yards] of [['sales', 'sales', [1]], ['other', 'sales', [28]], ['scm', 'scm', []], ['dispatch', 'dispatcher', []]]) {
    const username = `stock-update-${name}-${run}`; users.push(username);
    await createOperator({ username, displayName: `TEST ${name}`, password, role, roles: [role], yardLocationIds: yards });
    const login = await request('/api/auth/login', null, { username, password }); assert.equal(login.status, 200); sessions[name] = login.body;
  }
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [cases]);
  await query('DELETE FROM operators WHERE username=ANY($1::text[])', [users]);
  if (flag !== undefined) await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [flag]);
  await closeDb();
});
async function draft() {
  const d = await createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Customer', vendorId: 330, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
    lines: [{ productName: 'Stone', quantity: 2, uom: 'PCS', rate: 10, requiredDate: '2099-02-01' }] }, { operatorId: sessions.sales.operator.id, authorizedStoreLocationIds: [1] });
  cases.push(d.id); return d;
}
test('Information routes enforce role, yard, workflow flag and validation; concurrent requests and replies commit once', async () => {
  const d = await draft(), ask = `/api/scm/special-stock-requests/${d.id}/request-information`, reply = `/api/sales/special-stock-requests/${d.id}/information-update`;
  const body = { expectedRevision: d.revision, question: 'Confirm color.' };
  assert.equal((await request(ask, null, body)).status, 401);
  for (const role of ['sales', 'dispatch']) assert.equal((await request(ask, role, body)).status, 403);
  assert.equal((await request(ask, 'scm', { ...body, question: '' })).status, 400);
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'");
  assert.equal((await request(ask, 'scm', body)).status, 404);
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  const asking = await Promise.all([request(ask, 'scm', body), request(ask, 'scm', body)]);
  assert.deepEqual(asking.map(r => r.status).sort(), [200, 409]);
  const pending = asking.find(r => r.status === 200).body;
  assert.equal(pending.stage, 'pending_update');
  assert.equal(pending.events.filter(event => event.eventType === 'special_information_requested').length, 1);
  const salesReply = { expectedRevision: pending.revision, reply: 'Blue.', operatorId: sessions.scm.operator.id };
  for (const role of ['scm', 'dispatch']) assert.equal((await request(reply, role, salesReply)).status, 403);
  assert.equal((await request(reply, 'other', salesReply)).body.code, 'SPECIAL_CASE_STORE_FORBIDDEN');
  assert.equal((await request(reply, 'sales', { ...salesReply, reply: 'x'.repeat(4001) })).status, 400);
  const alert = await request('/api/sales/special-stock-requests/alerts', 'sales');
  assert.equal(alert.body.pendingUpdate, 1);
  const answering = await Promise.all([request(reply, 'sales', salesReply), request(reply, 'sales', salesReply)]);
  assert.deepEqual(answering.map(r => r.status).sort(), [200, 409]);
  const saved = await getSpecialStockCase(d.id, { audience: 'sales', authorizedStoreLocationIds: [1] });
  assert.equal(saved.stage, 'new_enquiry'); assert.equal(saved.revision, d.revision + 2);
  assert.equal(saved.informationRequest.answeredBy, sessions.sales.operator.id);
  assert.equal(saved.events.filter(event => event.eventType === 'special_information_updated').length, 1);
  assert.equal((await request('/api/sales/special-stock-requests/alerts', 'sales')).body.pendingUpdate, 0);
});
