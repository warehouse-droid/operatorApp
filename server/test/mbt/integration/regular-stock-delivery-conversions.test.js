import assert from 'node:assert/strict';
import test, {before, after} from 'node:test';
import {randomUUID} from 'node:crypto';
import fc from 'fast-check';
import {query, closeDb} from '../../../src/db.js';
import {calculateDeliveryStockRequest} from '../../../src/stock-request-repository.js';
import {submitDeliveryStockRequest, decideDeliveryStockRequest, retryDeliveryStockRequest} from '../../../src/regular-stock-delivery.js';
import {buildStockRequestTransferPayload} from '../../../src/stock-request-service.js';

const actor = 'delivery-conversions-' + randomUUID();
const itemId = 9800000000000 + parseInt(randomUUID().replaceAll('-', '').slice(0, 5), 16);
const context = {operatorId: actor, authorizedDestinationLocationIds: [1, 28, 15, 26]};
const baseId = parseInt(randomUUID().replaceAll('-', '').slice(0, 10), 16);
let sequence = 0;
const packs = line => [line.pallets, line.layers, line.sections, line.pieces];
const route = {sourceLocationId: 1, destinationLocationId: 28};
const locations = {source: {netsuiteLocationId: 1, subsidiaryId: 1}, destination: {netsuiteLocationId: 28}};

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true)", [actor]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_plt,to_lyr,to_sec,to_pcs) VALUES($1,'DELIVERY-CONVERSION-MATERIAL','PC',60,0,0,1)", [itemId]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,item_weight) VALUES(1800000056,'PALLET','EA',1,1,50) ON CONFLICT DO NOTHING");
  for (const location of [1, 28, 15]) {
    await query('INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,100000000,100000000,now())', [itemId, location, String(location)]);
  }
});
after(closeDb);

function fixture(source = 1, quantity = 160) {
  const id = baseId + (++sequence), ref = `SO-CONVERSION-${actor}-${sequence}`;
  const order = {id, ref, customerId: 42, locationId: 28, lines: [{remoteLineId: 1, itemId, quantity, backorderedQuantity: 78, uom: 'PC', locationId: 28, open: true}]};
  const payloads = [];
  const dependencies = {
    liveExecutionEnabled: true, readOrder: async () => structuredClone(order), refreshAvailability: async () => {},
    hydrateOrder: async () => {}, syncReplenishments: async () => {}, linkTransferDependency: async () => {},
    confirmTransfer: async transfer => {
      payloads.push(buildStockRequestTransferPayload({transfer, locations}));
      await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete',status='pending_fulfillment' WHERE id=$1", [transfer.id, 9600000 + transfer.id, `TO-CONVERSION-${transfer.id}`]);
    }
  };
  return {order, payloads, dependencies, input: {deliveryMethod: 'delivery', sourceLocationId: source, destinationLocationId: 28, salesOrderRef: ref}};
}

test('SO quantity 160 at 60 PCS per PLT saves 2 PLT and 40 PCS before manual approval', async () => {
  const f = fixture(15), request = await submitDeliveryStockRequest(f.input, context, f.dependencies);
  assert.equal(request.regular.deliveryApproval, 'pending');
  assert.equal(request.lines[0].salesQty, 160);
  assert.deepEqual(packs(request.lines[0]), [2, 0, 0, 40]);
  assert.equal(request.regular.palletQuantity, 3);
  assert.equal(f.payloads.length, 0);
});

test('automatic Delivery copies packing counts to its transfer and sends all four NetSuite columns', async () => {
  const f = fixture(), request = await submitDeliveryStockRequest(f.input, context, f.dependencies);
  assert.equal(request.regular.handoffStatus, 'complete', request.regular.handoffError);
  assert.deepEqual(packs(request.lines[0]), [2, 0, 0, 40]);
  assert.deepEqual(packs(request.transfers[0].lines[0]), [2, 0, 0, 40]);
  const stored = (await query('SELECT pallet_qty,layer_qty,section_qty,piece_qty FROM sales_stock_transfer_lines WHERE transfer_id=$1', [request.transfers[0].id])).rows;
  assert.equal(stored.length, 1);
  assert.deepEqual(['pallet_qty', 'layer_qty', 'section_qty', 'piece_qty'].map(key => Number(stored[0][key])), [2, 0, 0, 40]);
  const material = f.payloads[0].item.items.find(line => Number(line.item.id) === itemId);
  assert.deepEqual(material, {item: {id: String(itemId)}, quantity: 160, custcol_plt: 2, custcol_lyr: 0, custcol_sec: 0, custcol_pcs: 40});
  const pallet = f.payloads[0].item.items.find(line => Number(line.item.id) !== itemId);
  assert.equal(pallet.quantity, 3);
  assert.equal(pallet.custcol_pcs, 3);
  const retry = await retryDeliveryStockRequest(request.id, context, f.dependencies);
  assert.equal(retry.transfers[0].id, request.transfers[0].id);
  assert.equal(f.payloads.length, 1);
});

test('stock drop at approval refreshes Sales quantity and all packing fields together', async () => {
  const f = fixture(15), pending = await submitDeliveryStockRequest(f.input, context, f.dependencies);
  await query('UPDATE inventory_balances SET quantity_available=80 WHERE item_id=$1 AND location_id=15', [itemId]);
  try {
    const request = await decideDeliveryStockRequest(pending.id, {decision: 'stock', expectedRevision: pending.revision}, context, f.dependencies);
    assert.equal(request.regular.handoffStatus, 'complete', request.regular.handoffError);
    assert.equal(request.lines[0].salesQty, 78);
    assert.deepEqual(packs(request.lines[0]), [1, 0, 0, 18]);
    assert.deepEqual(packs(request.transfers[0].lines[0]), [1, 0, 0, 18]);
    assert.equal(f.payloads[0].item.items[0].custcol_pcs, 18);
    assert.equal(request.transfers[0].palletQuantity, 2);
  } finally {
    await query('UPDATE inventory_balances SET quantity_available=100000000 WHERE item_id=$1 AND location_id=15', [itemId]);
  }
});

test('changed conversion snapshot at approval refreshes PLT LYR SEC PCS even when Sales quantity is unchanged', async () => {
  const f = fixture(15, 149), pending = await submitDeliveryStockRequest(f.input, context, f.dependencies);
  await query('UPDATE inventory_items SET to_plt=120,to_lyr=20,to_sec=5 WHERE item_id=$1', [itemId]);
  try {
    const request = await decideDeliveryStockRequest(pending.id, {decision: 'stock', expectedRevision: pending.revision}, context, f.dependencies);
    assert.equal(request.lines[0].salesQty, 149);
    assert.deepEqual(packs(request.lines[0]), [1, 1, 1, 4]);
    assert.deepEqual(packs(request.transfers[0].lines[0]), [1, 1, 1, 4]);
    assert.equal(request.transfers[0].lines[0].toPlt, 120);
    assert.deepEqual(f.payloads[0].item.items[0], {item: {id: String(itemId)}, quantity: 149, custcol_plt: 1, custcol_lyr: 1, custcol_sec: 1, custcol_pcs: 4});
  } finally {
    await query('UPDATE inventory_items SET to_plt=60,to_lyr=0,to_sec=0 WHERE item_id=$1', [itemId]);
  }
});

test('repeated SKU lines retain exact combined conversion quantity and one official PALLET line', async () => {
  const f = fixture(1, 110);
  f.order.lines[0].backorderedQuantity = 20;
  f.order.lines.push({...f.order.lines[0], remoteLineId: 2, quantity: 50, backorderedQuantity: 1});
  const request = await submitDeliveryStockRequest(f.input, context, f.dependencies);
  const items = f.payloads[0].item.items, material = items.find(line => Number(line.item.id) === itemId);
  assert.equal(items.length, 2);
  assert.equal(material.quantity, 160);
  assert.equal(material.custcol_plt * 60 + material.custcol_pcs, 160);
  assert.equal(request.transfers[0].palletQuantity, 3);
});

test('property: calculated packing preserves chosen Sales quantity across mixed units and fractional remainders', async () => {
  await query('UPDATE inventory_items SET to_plt=60,to_lyr=10,to_sec=5 WHERE item_id=$1', [itemId]);
  try {
    await fc.assert(fc.asyncProperty(fc.integer({min: 1, max: 200000}), async cents => {
      const quantity = cents / 100;
      const result = await calculateDeliveryStockRequest(route, [{remoteLineId: 1, itemId, quantity, backorderedQuantity: quantity, uom: 'PC'}]);
      const line = result.lines[0];
      assert.equal(line.salesQty, quantity);
      assert(Math.abs(line.pallets * 60 + line.layers * 10 + line.sections * 5 + line.pieces - quantity) < 0.000001);
      assert(line.pallets >= 0 && Number.isInteger(line.pallets));
      assert(line.layers >= 0 && line.layers < 6 && Number.isInteger(line.layers));
      assert(line.sections >= 0 && line.sections < 2 && Number.isInteger(line.sections));
      assert(line.pieces >= 0 && line.pieces < 5);
      assert.equal(result.palletQuantity, Math.ceil(quantity / 60));
    }), {seed: 121863, numRuns: 80});
  } finally {
    await query('UPDATE inventory_items SET to_plt=60,to_lyr=0,to_sec=0 WHERE item_id=$1', [itemId]);
  }
});

test('property: approval persists the refreshed packing snapshot to both request and transfer', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 100, max: 200}), fc.constantFrom(20, 40, 80), async (quantity, toPlt) => {
    const f = fixture(15, quantity), pending = await submitDeliveryStockRequest(f.input, context, f.dependencies);
    await query('UPDATE inventory_balances SET quantity_available=80 WHERE item_id=$1 AND location_id=15', [itemId]);
    await query('UPDATE inventory_items SET to_plt=$2 WHERE item_id=$1', [itemId, toPlt]);
    try {
      const request = await decideDeliveryStockRequest(pending.id, {decision: 'stock', expectedRevision: pending.revision}, context, f.dependencies);
      assert.equal(request.regular.handoffStatus, 'complete', request.regular.handoffError);
      for (const line of [request.lines[0], request.transfers[0].lines[0]]) {
        assert.equal(line.salesQty, 78);
        assert.equal(line.toPlt, toPlt);
        assert.equal(line.pallets * toPlt + line.pieces, 78);
        assert(line.pallets >= 0 && Number.isInteger(line.pallets));
        assert(line.pieces >= 0 && line.pieces < toPlt);
        assert.equal(line.layers, 0);
        assert.equal(line.sections, 0);
      }
      const stored = (await query('SELECT sales_qty,to_plt,pallet_qty,layer_qty,section_qty,piece_qty FROM sales_stock_transfer_lines WHERE transfer_id=$1', [request.transfers[0].id])).rows;
      assert.equal(stored.length, 1);
      assert.equal(Number(stored[0].sales_qty), 78);
      assert.equal(Number(stored[0].to_plt), toPlt);
      assert.equal(Number(stored[0].pallet_qty) * toPlt + Number(stored[0].piece_qty), 78);
      assert.equal(Number(stored[0].layer_qty), 0);
      assert.equal(Number(stored[0].section_qty), 0);
      assert.equal(f.payloads.length, 1);
      assert.equal(request.transfers[0].palletQuantity, Math.ceil(78 / toPlt));
    } finally {
      await query('UPDATE inventory_balances SET quantity_available=100000000 WHERE item_id=$1 AND location_id=15', [itemId]);
      await query('UPDATE inventory_items SET to_plt=60 WHERE item_id=$1', [itemId]);
    }
  }), {seed: 121864, numRuns: 16});
});
