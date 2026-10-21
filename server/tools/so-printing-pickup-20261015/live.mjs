import assert from 'node:assert/strict';
import { query, closeDb } from './src/db.js';
import { getSalesOrderPrintCandidate, listSalesOrderPrintCandidates } from './src/sales-repository.js';

try {
  const health = await fetch('http://127.0.0.1:3000/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const page = await fetch('http://127.0.0.1:3000/sales/printing');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /sales-printing\.js\?v=20261015-pickup-printing-v1/);
  const script = await fetch('http://127.0.0.1:3000/sales-printing.js?v=20261015-pickup-printing-v1');
  assert.equal(script.status, 200);
  assert.match(await script.text(), /Delivery &amp; Pickup Sales Orders/);
  const sample = await query(`SELECT DISTINCT so.netsuite_id, so.tranid
    FROM sales_orders so JOIN sales_order_lines line ON line.sales_order_id = so.netsuite_id
    WHERE so.netsuite_active = true AND line.netsuite_active = true
      AND lower(trim(COALESCE(so.sales_order_type, ''))) IN ('pick-up', 'pickup', 'pick up')
      AND upper(trim(COALESCE(line.item_type, ''))) = 'INVTPART'
      AND (so.order_location_id IN (1,28,15,26)
        OR (so.order_location_id IS NULL AND left(upper(so.tranid), 3) IN ('SOB','SOA','SOM')))
    ORDER BY so.netsuite_id DESC LIMIT 1`);
  let pickupSearchVerified = false;
  if (sample.rowCount) {
    const order = sample.rows[0];
    const candidate = await getSalesOrderPrintCandidate({ orderId: order.netsuite_id, allowedOrderingLocationIds: [1,28,15,26] });
    const search = await listSalesOrderPrintCandidates({ search: order.tranid, orderingLocationIds: [1,28,15,26] });
    assert.ok(search.some(row => row.orderId === candidate.orderId));
    pickupSearchVerified = true;
  }
  console.log(JSON.stringify({ healthy: true, updatedPageServed: true, pickupSearchVerified, physicalPrintJobsCreated: 0 }));
} finally {
  await closeDb();
}
