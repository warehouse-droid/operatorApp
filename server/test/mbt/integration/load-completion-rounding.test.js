import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { confirmCustomerPickupLine, getDeliveryOrder, recordCustomerPickupLoad, recordDeliveryLoad } from '../../../src/delivery-repository.js';
import { seedOperatorPickup } from '../../support/operator-ui-enhancements-fixture.mjs';
import { packingOrder, packingGroup, packingState } from '../../support/group-underpack-fixture.mjs';

after(closeDb);
const scenario = run => withTransaction(run, { rollback: true });
const photos = { photoDataUrls: ['data:image/png;base64,dGVzdDE=', 'data:image/png;base64,dGVzdDI='] };
const confirm = (f, values) => confirmCustomerPickupLine(f.orderId, f.lineId, { ...values, quantityMode: 'absolute' }, f.operator.id);
async function pickup() {
  const f = await seedOperatorPickup({ quantity: 779.75 });
  await query(`UPDATE sales_order_lines SET unit='SQFT', pallet_qty=8, layer_qty=5, piece_qty=0,
    to_plt=91.14, to_lyr=10.1267, to_pcs=0, pack_quantity_source='netsuite_manual' WHERE id=$1`, [f.lineId]);
  return f;
}
const detailLine = async f => (await getDeliveryOrder(f.orderId)).lines.find(row => String(row.id) === f.lineId);

test('SOA10636 server disallows a phantom layer on already loaded lines', async () => scenario(async () => {
  const f = await pickup();
  for (const [pallets, layers, quantity] of [[8, 5, 779.75], [1, 2, 111.39]]) {
    await query('UPDATE sales_order_lines SET pallet_qty=$2,layer_qty=$3,quantity=$4,loaded_qty=$4 WHERE id=$1', [f.lineId, pallets, layers, quantity]);
    await confirm(f, { layers: 1 });
    assert.equal(Number((await detailLine(f)).packed_layer_qty), 0);
  }
}));

test('pickup recomputes completion after each load and prevents a second load after completion', async () => scenario(async () => {
  const f = await pickup();
  await confirm(f, { pallets: 4, layers: 5 });
  const first = await recordCustomerPickupLoad(f.orderId, f.operator.id, photos);
  assert.equal(first.pickupStatus, 'partial_loaded');
  assert.equal(first.remainingLines, 1);
  await confirm(f, { pallets: 4 });
  const final = await recordCustomerPickupLoad(f.orderId, f.operator.id, photos);
  assert.equal(final.pickupStatus, 'loaded');
  assert.equal(final.remainingLines, 0);
  assert.equal(Number((await detailLine(f)).loaded_qty), 779.75);
  await confirm(f, { layers: 1 });
  assert.equal(Number((await detailLine(f)).packed_layer_qty), 0);
  await assert.rejects(recordCustomerPickupLoad(f.orderId, f.operator.id, photos), /Confirm at least one pickup line/);
  assert.equal(Number((await query('SELECT count(*) AS n FROM operator_load_records WHERE order_id=$1', [f.orderId])).rows[0].n), 2);
}));

test('SO, TO and group loading check completion using exact rounded totals after every load', async () => scenario(async () => {
  for (const transfer of [false, true]) {
    const order = await packingOrder({ transfer, quantity: 111.39, layers: 2, conversion: 10.1267, packed: 1, loaded: 91.14 });
    await query(`UPDATE ${order.lineTable} SET pallet_qty=1,to_plt=91.14 WHERE id=$1`, [order.lineId]);
    const group = await packingGroup([order]);
    const first = await recordDeliveryLoad(group, null, photos);
    assert.equal((await getDeliveryOrder(order.id)).operator_status, 'partial_loaded');
    assert(first);
    await query(`UPDATE ${order.lineTable} SET packed_layer_qty=1 WHERE id=$1`, [order.lineId]);
    await recordDeliveryLoad(group, null, photos);
    const detail = await getDeliveryOrder(order.id);
    assert.equal(detail.operator_status, 'loaded');
    assert.equal(Number(detail.lines[0].loaded_qty), 111.39);
  }
}));

test('a 0.01 or 0.1 local sales shortage stays partial instead of using posting tolerance', async () => scenario(async () => {
  for (const quantity of [10.14, 10.23]) {
    const order = await packingOrder({ quantity, layers: 1, conversion: 10.1267, packed: 1 });
    const result = await recordDeliveryLoad(order.id, null, photos);
    assert.equal(result.localYardOrderStatus, 'Partial Loaded');
    assert.equal(result.remainingLines, 1);
    assert.equal(Number((await getDeliveryOrder(order.id)).lines[0].loaded_qty), 10.1267);
  }
}));

test('a whole missing small layer cannot be completed by the old 0.1 snap', async () => scenario(async () => {
  const order = await packingOrder({ quantity: 0.15, layers: 3, conversion: 0.05, packed: 2 });
  const result = await recordDeliveryLoad(order.id, null, photos);
  assert.equal(result.localYardOrderStatus, 'Partial Loaded');
  assert.equal(Number((await getDeliveryOrder(order.id)).lines[0].loaded_qty), 0.1);
}));

test('a whole-layer excess is rejected without committing load progress', async () => scenario(async () => {
  const order = await packingOrder({ quantity: 0.13, layers: 1, conversion: 10.1267, packed: 1 });
  const before = await packingState(order);
  await assert.rejects(recordDeliveryLoad(order.id, null, photos), { code: 'DELIVERY_LOAD_VALIDATION_FAILED' });
  assert.deepEqual(await packingState(order), before);
  assert.equal(Number((await query('SELECT count(*) AS n FROM operator_load_records WHERE order_id=$1', [order.id])).rows[0].n), 0);
}));
