import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import { confirmCustomerPickupLine, confirmDeliveryLine, confirmDeliveryLines,
  getDeliveryOrder, recordCustomerPickupLoad, recordDeliveryLoad,
  setDeliveryLinePackedQuantity, updateDeliveryStatus } from '../../../src/delivery-repository.js';
import { seedOperatorPickup } from '../../support/operator-ui-enhancements-fixture.mjs';
import { packingGroup, packingOrder } from '../../support/group-underpack-fixture.mjs';

after(closeDb);
const photos = { photoDataUrls: ['data:image/png;base64,dGVzdDE=', 'data:image/png;base64,dGVzdDI='] };
async function scenario(run) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(run); } finally { await rollback.rollback(); }
}
async function fixture(delivery = false) {
  const f = await seedOperatorPickup({ quantity: 25 });
  await query(`UPDATE sales_order_lines SET pallet_qty=1, piece_qty=5, to_plt=20,
    to_lyr=5, to_sec=10, pack_quantity_source='netsuite_manual' WHERE id=$1`, [f.lineId]);
  if (delivery) { await query("UPDATE sales_orders SET sales_order_type='Delivery' WHERE netsuite_id=$1", [f.orderId]); }
  return f;
}
async function line(f) { return (await getDeliveryOrder(f.orderId)).lines.find(row => String(row.id) === f.lineId); }
const confirm = (f, values) => confirmCustomerPickupLine(f.orderId, f.lineId,
  { ...values, quantityMode: 'absolute' }, f.operator.id);
const packedTotal = row => Number(row.packed_pallet_qty) * 20 + Number(row.packed_layer_qty) * 5
  + Number(row.packed_section_qty) * 10 + Number(row.packed_piece_qty);

test('1 PLT + 5 PCS: pick up 10 PCS, then 15 PCS; completion and original order stay correct', () => scenario(async () => {
  const f = await fixture();
  await confirm(f, { pieces: 10 });
  assert.equal(Number((await line(f)).packed_piece_qty), 10);
  const first = await recordCustomerPickupLoad(f.orderId, f.operator.id, photos);
  assert.equal(first.loaded.salesQuantity, 10);
  assert.equal(first.pickupStatus, 'partial_loaded');
  assert.equal(first.remainingLines, 1);
  assert.equal(Number((await line(f)).loaded_qty), 10);
  await confirm(f, { pallets: 1, pieces: 20 });
  const remaining = await line(f);
  assert.equal(Number(remaining.packed_pallet_qty), 0);
  assert.equal(Number(remaining.packed_piece_qty), 15);
  const second = await recordCustomerPickupLoad(f.orderId, f.operator.id, photos);
  assert.equal(second.loaded.salesQuantity, 15);
  assert.equal(second.pickupStatus, 'loaded');
  assert.equal(second.remainingLines, 0);
  const final = await line(f);
  assert.equal(Number(final.loaded_qty), 25);
  assert.equal(Number(final.quantity), 25);
  assert.equal(Number(final.pallet_qty), 1);
  assert.equal(Number(final.piece_qty), 5);
  assert.equal(packedTotal(final), 0);
}));

test('pickup caps combinations, repeat edits and additive requests against one total', () => scenario(async () => {
  const f = await fixture();
  for (const values of [{ pallets: 1, pieces: 10 }, { layers: 3, sections: 1, pieces: 5 },
    { pieces: 26 }, { pallets: 2, layers: 5, sections: 4, pieces: 100 }]) {
    await confirm(f, values);
    assert.equal(packedTotal(await line(f)), 25);
  }
  await confirm(f, { pieces: 10 });
  await confirm(f, { pieces: 10 });
  assert.equal(packedTotal(await line(f)), 10);
  await confirmCustomerPickupLine(f.orderId, f.lineId, { pieces: 30 }, f.operator.id);
  assert.equal(packedTotal(await line(f)), 25);
}));

test('Delivery Prep confirms, edits and loads converted partial quantities with the same balance', () => scenario(async () => {
  const f = await fixture(true);
  await confirmDeliveryLine(f.orderId, f.lineId, { pieces: 10 }, f.operator.id);
  assert.equal(Number((await line(f)).packed_piece_qty), 10);
  await setDeliveryLinePackedQuantity(f.orderId, f.lineId, { layers: 2 }, f.operator.id);
  assert.equal(packedTotal(await line(f)), 10);
  await updateDeliveryStatus(f.orderId, 'packed', f.operator.id);
  const first = await recordDeliveryLoad(f.orderId, f.operator.id, photos);
  assert.equal(first.remainingLines, 1);
  assert.equal(Number((await line(f)).loaded_qty), 10);
  const page = await confirmDeliveryLines(f.orderId, [{ lineId: f.lineId, values: { pieces: 15 } }], f.operator.id);
  assert.equal(page.confirmed, 1);
  assert.deepEqual(page.failures, []);
  assert.equal(Number((await line(f)).packed_piece_qty), 15);
  await updateDeliveryStatus(f.orderId, 'packed', f.operator.id);
  const second = await recordDeliveryLoad(f.orderId, f.operator.id, photos);
  assert.equal(second.remainingLines, 0);
  assert.equal(Number((await line(f)).loaded_qty), 25);
}));

test('grouped Delivery Prep shares capacity within each source and spills remaining quantities to the next source', () => scenario(async () => {
  const actor = (await fixture()).operator.id;
  const orders = [await packingOrder({ quantity: 25, packed: 0 }), await packingOrder({ quantity: 25, packed: 0 })];
  for (const order of orders) {
    await query(`UPDATE sales_order_lines SET unit='PC', pallet_qty=1, piece_qty=5,
      layer_qty=0, to_plt=20, to_lyr=5, to_sec=10, to_pcs=1 WHERE id=$1`, [order.lineId]);
  }
  const groupId = await packingGroup(orders), group = await getDeliveryOrder(groupId);
  assert.equal(group.lines.length, 1);
  await setDeliveryLinePackedQuantity(groupId, group.lines[0].id, { pallets: 1, pieces: 30 }, actor);
  const sources = await Promise.all(orders.map(order => getDeliveryOrder(order.id)));
  assert.deepEqual(sources.map(order => packedTotal(order.lines[0])), [25, 25]);
  assert.deepEqual(sources.map(order => Number(order.lines[0].packed_piece_qty)), [5, 25]);
  await setDeliveryLinePackedQuantity(groupId, group.lines[0].id, { pieces: 10 }, actor);
  assert.equal(packedTotal((await getDeliveryOrder(orders[0].id)).lines[0]), 10);
  assert.equal(packedTotal((await getDeliveryOrder(orders[1].id)).lines[0]), 0);
}));

test('Transfer Order Delivery Prep can load loose pieces from the pallet balance', () => scenario(async () => {
  const actor = (await fixture()).operator.id;
  const order = await packingOrder({ transfer: true, quantity: 25, layers: 0, packed: 0 });
  await query(`UPDATE transfer_order_lines SET unit='PC', pallet_qty=1, piece_qty=5,
    to_plt=20,to_lyr=0,to_pcs=1 WHERE id=$1`, [order.lineId]);
  await setDeliveryLinePackedQuantity(order.id, order.lineId, { pieces: 10 }, actor);
  const first = await recordDeliveryLoad(order.id, actor, photos);
  assert.equal(first.remainingLines, 1);
  assert.equal(Number((await getDeliveryOrder(order.id)).lines[0].loaded_qty), 10);
  await confirmDeliveryLine(order.id, order.lineId, { pieces: 15 }, actor);
  await updateDeliveryStatus(order.id, 'packed', actor);
  const last = await recordDeliveryLoad(order.id, actor, photos);
  assert.equal(last.remainingLines, 0);
  assert.equal(Number((await getDeliveryOrder(order.id)).lines[0].loaded_qty), 25);
}));
