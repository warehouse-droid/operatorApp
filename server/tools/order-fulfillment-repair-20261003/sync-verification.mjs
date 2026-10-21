import assert from 'node:assert/strict';
import {query, withTransaction, closeDb} from 'file:///app/src/db.js';
import {fetchDeliveryOrderDetailsFromNetSuite} from 'file:///app/src/netsuite.js';
import {upsertSalesOrderLines} from 'file:///app/src/order-sync-repository.js';
import {getDeliveryOrder} from 'file:///app/src/delivery-repository.js';

// Exercise the deployed refresh path, with all local changes rolled back.
const id = 1033859;
try {
  const native = await fetchDeliveryOrderDetailsFromNetSuite(id);
  assert.equal(native.length, 1);
  assert.equal(native[0].quantity, 1);
  assert.equal(native[0].unit, 'Yard');
  const snapshot = async () => (await query(
    'SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id', [id]
  )).rows;
  const before = await snapshot();
  const result = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='5s'");
    await query("SET LOCAL statement_timeout='30s'");
    await upsertSalesOrderLines(id, native);
    const order = await getDeliveryOrder(id, {includeNetSuiteClosed: true});
    const lines = await snapshot();
    assert.equal(Number(lines[0].quantity), 1);
    assert.equal(Number(lines[0].loaded_qty), 1);
    assert.equal(order.operator_status, 'loaded');
    assert(!order.posting?.loadBlocked);
    return {order: 'SOM06812', nativeQuantity: 1, unit: 'Yard',
      afterRefreshQuantity: 1, loadedQuantity: 1, reviewHeld: false};
  }, {rollback: true});
  assert.deepEqual(await snapshot(), before);
  console.log(JSON.stringify({...result, refreshRolledBack: true}));
} finally {
  await closeDb();
}
