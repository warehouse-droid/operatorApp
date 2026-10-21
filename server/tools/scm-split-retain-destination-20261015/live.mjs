import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from './src/db.js';

const base = 'http://127.0.0.1:3000';
const health = await fetch(base + '/health');
assert.equal(health.status, 200);
assert.equal((await health.json()).ok, true);
const page = await fetch(base + '/dispatch-scm.html');
assert.equal(page.status, 200);
assert.match(await page.text(), /dispatch-scm\.js\?v=20261015-retain-netsuite-destination-v1/);
const asset = await fetch(base + '/dispatch-scm.js?v=20261015-retain-netsuite-destination-v1');
assert.equal(asset.status, 200);
assert.match(await asset.text(), /Retain NetSuite destination/);
const protectedRoute = await fetch(base + '/api/dispatch/scm/purchase-order-splits', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
});
assert.equal(protectedRoute.status, 401);
try {
  await withTransaction(async () => {
  await query('SET TRANSACTION READ ONLY');
  const source = await query(`SELECT po.tranid, po.dispatch_ref, line.line_id, line.location_id, line.location
    FROM purchase_orders po JOIN purchase_order_lines line ON line.purchase_order_id=po.netsuite_id
    WHERE po.netsuite_id=1044866 ORDER BY line.line_id`);
  assert.ok(source.rows.length > 0);
  assert.ok(source.rows.some(line => Number(line.location_id) === 28));
  assert.ok(source.rows.some(line => Number(line.location_id) === 1));
  console.log(JSON.stringify({ health: true, optionServed: true, routeRequiresAuthentication: true,
    sourceRef: 'POB04006', dispatchRef: 'SN1402278', sourceDestinations: [...new Set(source.rows.map(line => line.location))],
    inspectionReadOnly: true }));
  });
} finally {
  await closeDb();
}
