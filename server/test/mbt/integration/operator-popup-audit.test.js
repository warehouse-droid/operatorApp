import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { app } from '../../../src/server.js';
import { createOperator, loginOperator, listAudit } from '../../../src/auth-repository.js';
import { query, closeDb } from '../../../src/db.js';

let server, base, session;
const orderId = 9912630101, foreignId = 9912630102;
const body = (extra = {}) => ({ popupId: crypto.randomUUID(), action: 'displayed', orderId: String(orderId), locationId: 1,
  notificationKey: 'transfer_order:test:planned:2026-10-26::CC46868:Load 4:', clientTime: '2026-10-26T18:00:00.000Z',
  visibility: 'visible', notificationPermission: 'denied', planDate: '2026-10-26', truck: 'CC46868', load: 'Load 4', parkingSpot: '', ...extra });
async function send(payload, token = session.token) {
  const response = await fetch(`${base}/api/delivery/notification-events`, { method: 'POST', headers: {
    'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
  return { status: response.status, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text() };
}
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const username = `popup-${crypto.randomUUID()}`, password = crypto.randomUUID();
  await createOperator({ username, password, displayName: 'Popup test', role: 'operator', operatorYardLocationIds: [1] });
  session = await loginOperator(username, password);
  for (const [id, ref, yard] of [[orderId, 'TO-POPUP-TEST', 1], [foreignId, 'TO-POPUP-FOREIGN', 28]]) {
    await query(`INSERT INTO transfer_orders(netsuite_id,tranid,from_location_id,from_location,to_location_id,to_location,status,status_text,outbound_operator_status,local_yard_order_status,netsuite_active)
      VALUES($1,$2,$3,$4,15,'12441','B','Pending Fulfillment','open','Open',true)`, [id, ref, yard, yard === 1 ? '3445' : '2967']);
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await query('DELETE FROM transfer_orders WHERE netsuite_id=ANY($1::bigint[])', [[orderId, foreignId]]);
  await closeDb();
});

test('A1 receipt is searchable in Control audit with canonical order and authenticated actor', async () => {
  const event = body({ actorOperatorId: 'forged', tranid: 'FORGED', token: 'must-not-store' });
  assert.equal((await send(event)).status, 200);
  const rows = await listAudit({ action: 'delivery.popup.displayed', tranid: 'TO-POPUP-TEST' });
  const row = rows.find(item => item.details.popupId === event.popupId);
  assert.ok(row); assert.equal(row.actor_operator_id, session.operator.id); assert.equal(row.tranid, 'TO-POPUP-TEST');
  assert.equal(row.details.locationId, 1); assert.equal(row.details.parkingSpot, '');
  assert.equal(row.details.clientReported, true); assert.ok(row.created_at);
  assert.equal(JSON.stringify(row.details).includes('must-not-store'), false);
});

test('A2 concurrent retries write one audit event; actions remain distinct', async () => {
  const event = body();
  const responses = await Promise.all(Array.from({ length: 8 }, () => send(event)));
  assert.ok(responses.every(result => result.status === 200));
  assert.equal((await send({ ...event, action: 'dismissed' })).status, 200);
  const rows = await query("SELECT action FROM delivery_audit_log WHERE source='operator-popup' AND details->>'popupId'=$1", [event.popupId]);
  assert.deepEqual(rows.rows.map(row => row.action).sort(), ['delivery.popup.dismissed', 'delivery.popup.displayed']);
});

test('A3 login and yard checks reject forged receipts without semantic audit rows', async () => {
  const event = body();
  assert.equal((await send(event, '')).status, 401);
  assert.equal((await send({ ...event, locationId: 28 })).status, 403);
  assert.equal((await send({ ...event, orderId: String(foreignId) })).status, 403);
  const rows = await query("SELECT id FROM delivery_audit_log WHERE source='operator-popup' AND details->>'popupId'=$1", [event.popupId]);
  assert.equal(rows.rowCount, 0);
});

test('A4 malformed and oversized receipts fail without being recorded', async () => {
  for (const extra of [{ action: 'execute' }, { popupId: 'not-a-uuid' }, { notificationKey: 'x'.repeat(513) },
    { clientTime: 'invalid' }, { visibility: 'other' }, { action: 'displayed', visibility: 'hidden' }]) {
    const event = body(extra);
    assert.equal((await send(event)).status, 400, JSON.stringify(extra).slice(0, 100));
    const rows = await query("SELECT id FROM delivery_audit_log WHERE source='operator-popup' AND details->>'popupId'=$1", [event.popupId]);
    assert.equal(rows.rowCount, 0);
  }
});
