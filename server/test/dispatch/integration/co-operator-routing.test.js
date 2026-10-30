import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import fc from 'fast-check';
import { closeDb, query, withTransaction, pool } from '../../../src/db.js';
import { upsertLocalCoOrder } from '../../../src/dispatch-repository.js';
import { getDeliveryOrder, getDeliveryOrdersBatch, listDeliveryOrders, listDeliveryLoadTrucks, confirmDeliveryLine,
  setDeliveryLinePackedQuantity, unpackDeliveryLine, updateDeliveryStatus, recordDeliveryLoad } from '../../../src/delivery-repository.js';
import { getLocalCoReceivingOrder, confirmLocalCoReceivingLine, unconfirmLocalCoReceivingLine, receiveLocalCoOrder } from '../../../src/receiving-repository.js';
import { assertOperatorOrderYard } from '../../../src/operator-yard-authorization.js';
import { packingOrder, packingGroup, packingState } from '../../support/group-underpack-fixture.mjs';

after(closeDb);
const rollback = run => withTransaction(run, { rollback: true });

async function fixture({ grouped = true } = {}) {
  const actor = crypto.randomUUID();
  await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
    VALUES($1,$1,'CO regression','test','test','operator',ARRAY['operator'],true)`, [actor]);
  const sources = [await packingOrder({ quantity: 313.8, layers: 0, packed: 0 }),
    await packingOrder({ quantity: 251.04, layers: 4, packed: 0 })];
  const children = [];
  for (const [i, source] of sources.entries()) {
    await query("UPDATE sales_orders SET outbound_location_id=28,outbound_location='2967',operator_status='open' WHERE netsuite_id=$1", [source.id]);
    await query(`UPDATE sales_order_lines SET line_id=$2,item_id=4755,sku='PER-EKO70S-RDM-AG',
      pallet_qty=$3,to_plt=104.6,to_lyr=10.46,location_id=28,location='2967' WHERE id=$1`, [source.lineId, i + 1, i ? 2 : 3]);
    children.push({ id: source.ref, type: 'SO', sourceYard: '2967', pickupLocations: ['2967'], items: [{
      lineRowId: Number(source.lineId), lineId: i + 1, itemId: 4755, sku: 'PER-EKO70S-RDM-AG',
      itemName: 'EKO fixture', itemType: 'InvtPart', quantity: i ? 251.04 : 313.8,
      pallets: i ? 2 : 3, layers: i ? 4 : 0, toPlt: 104.6, toLyr: 10.46, unit: 'SQFT'
    }] });
  }
  const ref = grouped ? await packingGroup(sources) : sources[0].ref;
  const selected = grouped ? children : children.slice(0, 1);
  const co = await upsertLocalCoOrder({ sourceOrderRef: ref, fromYard: '2967', toYard: '3445',
    requestedBy: actor, order: { id: ref, type: 'SO', childOrders: selected.map(child => child.id),
      childOrderDetails: selected, items: selected.flatMap(child => child.items) } });
  return { actor, sources, ref, co };
}

const rawCargo = async f => (await query('SELECT * FROM local_co_order_lines WHERE co_id=$1 ORDER BY line_id,id', [f.co.id])).rows;

test('CO combines matching source rows and preserves stored cargo and original orders', () => rollback(async () => {
  const f = await fixture();
  const before = await rawCargo(f);
  const sourceBefore = await Promise.all(f.sources.map(packingState));
  const order = await getDeliveryOrder(f.co.co_ref);
  assert.equal(order.lines.length, 1);
  assert.equal(order.line_count, 1);
  const line = order.lines[0];
  assert.equal(Number(line.quantity), 564.84);
  assert.equal(Number(line.pallet_qty), 5);
  assert.equal(Number(line.layer_qty), 4);
  assert.deepEqual(line.co_source_lines.map(source => String(source.id)), before.map(source => String(source.id)));
  assert.deepEqual(await rawCargo(f), before);
  assert.deepEqual(await Promise.all(f.sources.map(packingState)), sourceBefore);
}));

test('CO combined confirm, absolute edit and unpack preserve per-source quantities', () => rollback(async () => {
  const f = await fixture();
  const order = await getDeliveryOrder(f.co.co_ref);
  assert.equal(order.lines.length, 1);
  const line = order.lines[0];
  await confirmDeliveryLine(f.co.co_ref, line.id, { pallets: 5, layers: 4 }, f.actor);
  let rows = await rawCargo(f);
  assert.deepEqual(rows.map(row => [Number(row.packed_pallet_qty), Number(row.packed_layer_qty)]), [[3, 0], [2, 4]]);
  await setDeliveryLinePackedQuantity(f.co.co_ref, line.id, { pallets: 4, layers: 4 }, f.actor);
  rows = await rawCargo(f);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.packed_pallet_qty), 0), 4);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.packed_layer_qty), 0), 4);
  for (const row of rows) {assert.ok(Number(row.packed_pallet_qty) * 104.6 + Number(row.packed_layer_qty) * 10.46 <= Number(row.quantity) + 0.000001);}
  await unpackDeliveryLine(f.co.co_ref, line.id, {}, f.actor);
  assert.ok((await rawCargo(f)).every(row => Number(row.packed_pallet_qty) === 0 && Number(row.packed_layer_qty) === 0));
}));

test('CO grouping keeps mismatched units separate and accepts legacy numeric line IDs', () => rollback(async () => {
  const f = await fixture();
  const rows = await rawCargo(f);
  await confirmDeliveryLine(f.co.co_ref, rows[1].id, { pallets: 1 }, f.actor);
  assert.equal((await getDeliveryOrder(f.co.co_ref)).lines.length, 1);
  assert.deepEqual((await rawCargo(f)).map(row => Number(row.packed_pallet_qty)), [0, 1]);
  await query("UPDATE local_co_order_lines SET unit='OTHER' WHERE id=$1", [rows[1].id]);
  assert.equal((await getDeliveryOrder(f.co.co_ref)).lines.length, 2);
}));

test('grouped CO moves both SOs and the Operator group to its destination only', () => rollback(async () => {
  const f = await fixture();
  const origin = await listDeliveryOrders({ locationId: 28 });
  const destination = await listDeliveryOrders({ locationId: 1 });
  assert.ok(!origin.some(order => order.dispatch_group_id === f.ref || f.sources.some(source => order.tranid === source.ref)));
  assert.ok(origin.some(order => order.tranid === f.co.co_ref));
  assert.ok(destination.some(order => order.dispatch_group_id === f.ref));
  assert.ok(!destination.some(order => order.tranid === f.co.co_ref));
  for (const id of [f.ref, ...f.sources.map(source => source.id)]) {
    const detail = await getDeliveryOrder(id);
    assert.equal(Number(detail.outbound_location_id), 1);
    assert.equal(detail.outbound_location, '3445');
  }
  for (const detail of await getDeliveryOrdersBatch(f.sources.map(source => source.id))) {assert.equal(Number(detail.outbound_location_id), 1);}
  for (const source of f.sources) {assert.equal(Number((await packingState(source)).header[0].outbound_location_id), 28);}
}));

test('destination yard authorization applies to grouped and individual source orders', () => rollback(async () => {
  const f = await fixture();
  const operator = yard => ({ id: f.actor, role: 'operator', roles: ['operator'], operatorYardLocationIds: [yard] });
  for (const id of [f.ref, ...f.sources.map(source => source.id)]) {
    await assert.rejects(assertOperatorOrderYard(operator(28), id), error => error.status === 403);
    assert.ok(await assertOperatorOrderYard(operator(1), id));
  }
}));

test('loaded CO still blocks premature source packing until arrival', () => rollback(async () => {
  const f = await fixture();
  await query("UPDATE local_co_orders SET status='planned',loaded_at=now() WHERE id=$1", [f.co.id]);
  await assert.rejects(confirmDeliveryLine(f.sources[0].id, f.sources[0].lineId, { pallets: 1 }, f.actor),
    error => error.code === 'CO_SOURCE_PACKING_HANDOFF');
  await query("UPDATE local_co_orders SET status='received',received_at=now() WHERE id=$1", [f.co.id]);
  await confirmDeliveryLine(f.sources[0].id, f.sources[0].lineId, { pallets: 1 }, f.actor);
  assert.equal(Number((await packingState(f.sources[0])).lines[0].packed_pallet_qty), 1);
  assert.equal(Number((await getDeliveryOrder(f.sources[0].id)).outbound_location_id), 1);
}));

test('standalone source follows its CO and cancellation restores its original yard', () => rollback(async () => {
  const f = await fixture({ grouped: false });
  assert.ok((await listDeliveryOrders({ locationId: 1 })).some(order => order.tranid === f.sources[0].ref));
  assert.ok(!(await listDeliveryOrders({ locationId: 28 })).some(order => order.tranid === f.sources[0].ref));
  await query("UPDATE local_co_orders SET status='cancelled' WHERE id=$1", [f.co.id]);
  assert.ok((await listDeliveryOrders({ locationId: 28 })).some(order => order.tranid === f.sources[0].ref));
  assert.equal(Number((await getDeliveryOrder(f.sources[0].id)).outbound_location_id), 28);
}));

const photos = ['data:image/jpeg;base64,/9j/2Q==', 'data:image/jpeg;base64,/9j/4AAQ/9k='];

async function loadAndConfirmReceipt(f, { partial = false } = {}) {
  for (const line of await rawCargo(f)) {await confirmDeliveryLine(f.co.co_ref, line.id,
    { pallets: Number(line.pallet_qty), layers: Number(line.layer_qty) }, f.actor);}
  await updateDeliveryStatus(f.co.co_ref, 'packed', f.actor);
  await recordDeliveryLoad(f.co.co_ref, f.actor, { photoDataUrls: photos });
  const receiving = await getLocalCoReceivingOrder(f.co.co_ref);
  for (const line of receiving.lines) {await confirmLocalCoReceivingLine(f.co.co_ref, line.id,
    { pallets: partial ? 1 : Number(line.pallet_qty), layers: partial ? 0 : Number(line.layer_qty) }, f.actor);}
}

test('2967 pack and load then 3445 receipt makes the original SO group Packed and waiting for load', () => rollback(async () => {
  const f = await fixture();
  const before = await Promise.all(f.sources.map(packingState));
  await loadAndConfirmReceipt(f);
  await receiveLocalCoOrder(f.co.co_ref, f.actor, { photoDataUrls: photos });
  const packed = await listDeliveryOrders({ locationId: 1, status: 'packed' });
  assert.ok(packed.some(order => order.dispatch_group_id === f.ref));
  const detail = await getDeliveryOrder(f.ref);
  assert.equal(detail.operator_status, 'packed');
  assert.equal(Number(detail.outbound_location_id), 1);
  assert.equal(Number(detail.lines[0].packed_pallet_qty), 5);
  assert.equal(Number(detail.lines[0].packed_layer_qty), 4);
  assert.equal(Number(detail.lines[0].loaded_qty), 0);
  for (const [index, source] of f.sources.entries()) {
    const state = await packingState(source);
    assert.equal(state.header[0].operator_status, 'packed');
    for (const key of ['id', 'line_id', 'quantity', 'pallet_qty', 'layer_qty']) {assert.equal(state.lines[0][key], before[index].lines[0][key], key);}
  }
  assert.equal((await query('SELECT 1 FROM transfer_orders WHERE netsuite_id=$1', [f.co.delivery_order_id])).rowCount, 0);
  const receivedState = await Promise.all(f.sources.map(packingState));
  await assert.rejects(receiveLocalCoOrder(f.co.co_ref, f.actor, { photoDataUrls: photos }));
  assert.deepEqual(await Promise.all(f.sources.map(packingState)), receivedState);
}));

test('partial CO receipt packs only quantities actually received', () => rollback(async () => {
  const f = await fixture();
  await loadAndConfirmReceipt(f, { partial: true });
  await receiveLocalCoOrder(f.co.co_ref, f.actor, { photoDataUrls: photos });
  const detail = await getDeliveryOrder(f.ref);
  assert.equal(Number(detail.lines[0].packed_pallet_qty), 2);
  assert.equal(Number(detail.lines[0].packed_layer_qty), 0);
  assert.equal(detail.operator_status, 'packed');
  assert.ok(detail.underpack_count > 0);
}));

test('unconfirmed receipt cargo is not marked Packed on its source SO', () => rollback(async () => {
  const f = await fixture();
  await loadAndConfirmReceipt(f);
  const first = (await getLocalCoReceivingOrder(f.co.co_ref)).lines[0];
  await unconfirmLocalCoReceivingLine(f.co.co_ref, first.id, f.actor);
  await receiveLocalCoOrder(f.co.co_ref, f.actor, { photoDataUrls: photos });
  const source = await packingState(f.sources[0]);
  assert.equal(source.header[0].operator_status, 'open');
  assert.equal(Number(source.lines[0].packed_pallet_qty), 0);
  assert.equal((await packingState(f.sources[1])).header[0].operator_status, 'packed');
}));

test('receiving confirmation waits for the order lock and rejects a completed receipt', async () => {
  const f = await fixture();
  await loadAndConfirmReceipt(f);
  const line = (await getLocalCoReceivingOrder(f.co.co_ref)).lines[0];
  const client = await pool.connect();
  let operation, pid, waiting = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`operator-delivery-load:${f.co.delivery_order_id}`]);
    operation = withTransaction(async () => {
      pid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return confirmLocalCoReceivingLine(f.co.co_ref, line.id, { pallets: 1 }, f.actor);
    });
    operation.catch(() => null);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (pid) {
        waiting = (await client.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
        if (waiting) { break; }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await client.query("UPDATE co_orders SET status='received',received_at=now() WHERE id=$1", [f.co.id]);
    await client.query('COMMIT');
    await assert.rejects(operation, /CO receiving line not found/);
    assert.equal(waiting, true);
    assert.equal(Number((await getLocalCoReceivingOrder(f.co.co_ref)).lines[0].received_pallet_qty), Number(line.received_pallet_qty));
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await operation?.catch(() => null);
    await query('DELETE FROM local_co_orders WHERE id=$1', [f.co.id]);
    await query('DELETE FROM dispatch_delivery_groups WHERE group_ref=$1', [f.ref]);
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])', [f.sources.map(source => source.id)]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])', [f.sources.map(source => source.id)]);
  }
});

test('generated combined packing quantities retain exact totals and per-source capacity', () => rollback(async () => {
  const f = await fixture();
  const line = (await getDeliveryOrder(f.co.co_ref)).lines[0];
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 4 }), async (pallets, layers) => {
    await setDeliveryLinePackedQuantity(f.co.co_ref, line.id, { pallets, layers }, f.actor);
    const rows = await rawCargo(f);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.packed_pallet_qty), 0), pallets);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.packed_layer_qty), 0), layers);
    for (const row of rows) {assert.ok(Number(row.packed_pallet_qty) * 104.6 + Number(row.packed_layer_qty) * 10.46 <= Number(row.quantity) + 0.000001);}
  }), { seed: 1091910923, numRuns: 20 });
}));

test('combined packing rejects a pallet allocation that would overfill either original source', () => rollback(async () => {
  const f = await fixture();
  await query('UPDATE local_co_order_lines SET quantity=156.9,pallet_qty=1,layer_qty=5 WHERE co_id=$1', [f.co.id]);
  const before = await rawCargo(f);
  const line = (await getDeliveryOrder(f.co.co_ref)).lines[0];
  await assert.rejects(setDeliveryLinePackedQuantity(f.co.co_ref, line.id, { pallets: 3 }, f.actor), /exceeds the source lines/);
  assert.deepEqual(await rawCargo(f), before);
}));

test('onward trucks appear only at the CO destination yard', () => rollback(async () => {
  const f = await fixture();
  await query("UPDATE sales_orders SET dispatch_plan_date='2099-10-28',dispatch_truck_plate='CO-ONWARD',dispatch_load_name='Load 8' WHERE netsuite_id=ANY($1::bigint[])", [f.sources.map(source => source.id)]);
  assert.ok((await listDeliveryLoadTrucks({ locationId: 1, planDate: '2099-10-28' })).some(truck => truck.truck_plate === 'CO-ONWARD'));
  assert.ok(!(await listDeliveryLoadTrucks({ locationId: 28, planDate: '2099-10-28' })).some(truck => truck.truck_plate === 'CO-ONWARD'));
}));

test('receipt preserves onward schedule, original lines, and original load evidence identities', () => rollback(async () => {
  const f = await fixture();
  const raw = await rawCargo(f);
  await query("UPDATE sales_orders SET dispatch_plan_date='2099-10-28',dispatch_truck_plate='ONWARD',dispatch_load_name='Load 8' WHERE netsuite_id=ANY($1::bigint[])", [f.sources.map(source => source.id)]);
  await loadAndConfirmReceipt(f);
  const snapshot = (await query("SELECT line_snapshot FROM operator_load_records WHERE order_id=$1 AND load_type='local_co_load'", [f.co.delivery_order_id])).rows[0].line_snapshot;
  assert.deepEqual(snapshot.map(line => String(line.lineId)).sort(), raw.map(line => String(line.line_id)).sort());
  await receiveLocalCoOrder(f.co.co_ref, f.actor, { photoDataUrls: photos });
  for (const source of f.sources) {
    const header = (await packingState(source)).header[0];
    assert.equal(header.dispatch_truck_plate, 'ONWARD');
    assert.equal(header.dispatch_load_name, 'Load 8');
    assert.equal(Number(header.outbound_location_id), 28);
  }
}));

test('receipt audit failure rolls back source packing and the received state together', () => rollback(async () => {
  const f = await fixture();
  await loadAndConfirmReceipt(f);
  const before = await Promise.all(f.sources.map(packingState));
  await query(`CREATE FUNCTION pg_temp.reject_co_receipt() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'receipt audit unavailable'; END $$`);
  await query(`CREATE TRIGGER co_receipt_failure BEFORE INSERT ON local_co_receipt_records
    FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_co_receipt()`);
  await assert.rejects(receiveLocalCoOrder(f.co.co_ref, f.actor, { photoDataUrls: photos }), /receipt audit unavailable/);
  assert.deepEqual(await Promise.all(f.sources.map(packingState)), before);
  assert.equal((await query('SELECT status FROM local_co_orders WHERE id=$1', [f.co.id])).rows[0].status, 'planned');
}));

test('receipt rejects a missing source identity without partially packing another source', () => rollback(async () => {
  const f = await fixture();
  await loadAndConfirmReceipt(f);
  const before = await Promise.all(f.sources.map(packingState));
  await query(`UPDATE local_co_order_lines SET raw=jsonb_set(raw,'{lineRowId}','"missing"')
    WHERE co_id=$1 AND line_id=2`, [f.co.id]);
  await assert.rejects(receiveLocalCoOrder(f.co.co_ref, f.actor, { photoDataUrls: photos }), /original sales line/);
  assert.deepEqual(await Promise.all(f.sources.map(packingState)), before);
}));

test('receipt cannot overwrite a source sales line already loaded for delivery', () => rollback(async () => {
  const f = await fixture();
  await loadAndConfirmReceipt(f);
  await query('UPDATE sales_order_lines SET loaded_qty=quantity WHERE id=$1', [f.sources[0].lineId]);
  const before = await Promise.all(f.sources.map(packingState));
  await assert.rejects(receiveLocalCoOrder(f.co.co_ref, f.actor, { photoDataUrls: photos }), /already been loaded/);
  assert.deepEqual(await Promise.all(f.sources.map(packingState)), before);
  assert.equal((await query('SELECT status FROM local_co_orders WHERE id=$1', [f.co.id])).rows[0].status, 'planned');
}));

test('simultaneous receipt attempts apply packing once', async () => {
  const f = await fixture();
  try {
    await loadAndConfirmReceipt(f);
    const results = await Promise.allSettled([1, 2].map(() => receiveLocalCoOrder(f.co.co_ref, f.actor, { photoDataUrls: photos })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await query('SELECT 1 FROM local_co_receipt_records WHERE co_id=$1', [f.co.id])).rowCount, 1);
    const detail = await getDeliveryOrder(f.ref);
    assert.equal(Number(detail.lines[0].packed_pallet_qty), 5);
    assert.equal(Number(detail.lines[0].packed_layer_qty), 4);
  } finally {
    await query('DELETE FROM local_co_receipt_records WHERE co_id=$1', [f.co.id]);
    await query('DELETE FROM local_co_orders WHERE id=$1', [f.co.id]);
    await query('DELETE FROM dispatch_delivery_groups WHERE group_ref=$1', [f.ref]);
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])', [f.sources.map(source => source.id)]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])', [f.sources.map(source => source.id)]);
  }
});

test('Operator HTTP serves one CO line at origin and the Packed SO group at destination after receipt', async () => {
  const { app } = await import('../../../src/server.js');
  const f = await fixture();
  const token = crypto.randomBytes(24).toString('hex');
  await query('INSERT INTO operator_sessions(token_hash,operator_id,expires_at) VALUES($1,$2,now()+interval \'1 hour\')',
    [crypto.createHash('sha256').update(token).digest('hex'), f.actor]);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  try {
    await query('UPDATE operators SET operator_yard_location_ids=ARRAY[28] WHERE id=$1', [f.actor]);
    const coResponse = await get(`/api/delivery/orders/${f.co.co_ref}`);
    assert.equal(coResponse.status, 200);
    assert.equal((await coResponse.json()).lines.length, 1);
    assert.equal((await get(`/api/delivery/orders/${f.ref}`)).status, 403);
    await loadAndConfirmReceipt(f);
    await query('UPDATE operators SET operator_yard_location_ids=ARRAY[1] WHERE id=$1', [f.actor]);
    assert.equal((await get(`/api/delivery/orders/${f.ref}`)).status, 200);
    const received = await fetch(`${base}/api/receiving/orders/${f.co.co_ref}/receive`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orderType: 'co_order', photoDataUrls: photos, destinationLocationId: 1 })
    });
    const receipt = await received.json();
    assert.equal(received.status, 200, JSON.stringify(receipt));
    assert.equal(receipt.result.localYardOrderStatus, 'Packed');
    const response = await get(`/api/delivery/orders/${f.ref}`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.operator_status, 'packed');
    assert.equal(detail.co_waiting_for_arrival, false);
    assert.equal(Number(detail.lines[0].packed_pallet_qty), 5);
    assert.equal(Number(detail.lines[0].packed_layer_qty), 4);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await query('DELETE FROM local_co_receipt_records WHERE co_id=$1', [f.co.id]);
    await query('DELETE FROM local_co_orders WHERE id=$1', [f.co.id]);
    await query('DELETE FROM dispatch_delivery_groups WHERE group_ref=$1', [f.ref]);
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])', [f.sources.map(source => source.id)]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])', [f.sources.map(source => source.id)]);
  }
});
