import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { app } from '../../../src/server.js';
import { query, closeDb } from '../../../src/db.js';
import { seedOperatorPickup } from '../../support/operator-ui-enhancements-fixture.mjs';
import { setOutboundLocationDirectory } from '../../../src/outbound-location-domain.js';

let server, base, fixture;
async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  setOutboundLocationDirectory([{ id: 1 }, { id: 28 }, { id: 15 }, { id: 26 }, { id: 14, parent: 1 }, { id: 40, parent: 28 }]);
  fixture = await seedOperatorPickup();
  await query('UPDATE sales_orders SET outbound_location_id=14,outbound_location=$2 WHERE netsuite_id=$1', [fixture.orderId, '3445 : 3445 Special']);
  await query('UPDATE sales_order_lines SET location_id=14,netsuite_order_line=1 WHERE id=$1', [fixture.lineId]);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await closeDb(); });
test('H1 scanning a child-only pickup under its parent yard returns the real location', async () => {
  const result = await request('/api/customer-pickup/lookup', 'POST', { code: fixture.tranid, locationId: 1 });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(Number(result.data.outbound_location_id), 14);
  assert.equal(Number(result.data.lines[0].location_id), 14);
});
test('H2 child order detail accepts its parent yard and denies a forged foreign yard', async () => {
  assert.equal((await request(`/api/delivery/orders/${fixture.orderId}?locationId=1`)).status, 200);
  assert.equal((await request(`/api/delivery/orders/${fixture.orderId}?locationId=28`)).status, 403);
});
test('H3 changing a line to another yard blocks the whole outbound order', async () => {
  await query('UPDATE sales_order_lines SET location_id=40 WHERE id=$1', [fixture.lineId]);
  try { assert.equal((await request(`/api/delivery/orders/${fixture.orderId}?locationId=1`)).status, 403); }
  finally { await query('UPDATE sales_order_lines SET location_id=14 WHERE id=$1', [fixture.lineId]); }
});
test('H4 delivery lists include child-only orders under the parent yard', async () => {
  await query("UPDATE sales_orders SET sales_order_type='Delivery' WHERE netsuite_id=$1", [fixture.orderId]);
  try {
    const result = await request('/api/delivery/orders?locationId=1&orderType=sales_order');
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.ok(result.data.some(order => String(order.netsuite_id) === fixture.orderId));
  } finally { await query("UPDATE sales_orders SET sales_order_type='Pick-Up' WHERE netsuite_id=$1", [fixture.orderId]); }
});

test('H5 preparing child-location delivery remains recoverable from its parent yard', async () => {
  await query("UPDATE sales_orders SET sales_order_type='Delivery',operator_status='preparing',preparing_operator_id=$2,preparing_started_at=now() WHERE netsuite_id=$1", [fixture.orderId, fixture.operator.id]);
  try {
    const result = await request('/api/delivery/current-draft?locationId=1');
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(String(result.data?.netsuite_id), fixture.orderId);
    assert.equal(Number(result.data.location_id), 14);
  } finally { await query("UPDATE sales_orders SET sales_order_type='Pick-Up',operator_status='open',preparing_operator_id=NULL,preparing_started_at=NULL WHERE netsuite_id=$1", [fixture.orderId]); }
});
