import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from '../src/db.js';
import { getDeliveryOrder } from '../src/delivery-repository.js';

try {
  await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const co = await getDeliveryOrder('CO-GOA-10919-10923');
    const eko = co.lines.filter(line => line.sku === 'PER-EKO70S-RDM-AG');
    assert.equal(eko.length, 1);
    assert.equal(Number(eko[0].quantity), 564.84);
    assert.equal(Number(eko[0].pallet_qty), 5);
    assert.equal(Number(eko[0].layer_qty), 4);
    const group = await getDeliveryOrder('GROUP:GOA-10919-10923');
    assert.equal(Number(group.outbound_location_id), 1);
    assert.deepEqual(group.child_order_refs.toSorted(), ['SOA10919', 'SOA10923']);
    assert.ok(group.child_orders.every(order => Number(order.outbound_location_id) === 1));
    const raw = (await query(`SELECT count(*)::int AS rows FROM local_co_order_lines line
      JOIN local_co_orders co ON co.id=line.co_id WHERE co.co_ref='CO-GOA-10919-10923'`)).rows[0];
    assert.equal(raw.rows, 9);
    console.log(JSON.stringify({ co: co.tranid, ekoRows: eko.length, ekoQuantity: eko[0].quantity,
      ekoPallets: eko[0].pallet_qty, ekoLayers: eko[0].layer_qty, storedCargoRows: raw.rows,
      sourceGroup: group.child_order_refs, operatorYard: group.outbound_location,
      sourceStatuses: group.child_orders.map(order => ({ order: order.tranid, status: order.operator_status })),
      readOnly: true }));
  });
} finally {await closeDb();}
