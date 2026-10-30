import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { upsertLocalCoOrder } from '../../../src/dispatch-repository.js';
import { packingOrder, packingGroup, packingState } from '../../support/group-underpack-fixture.mjs';
import { confirmLocalCoReceivingLine, getLocalCoReceivingOrder, receiveLocalCoOrder } from '../../../src/receiving-repository.js';
import { getDeliveryOrder, recordDeliveryLoad } from '../../../src/delivery-repository.js';
import { buildCoTransferCorrection, readCoTransferCorrection, applyCoTransferCorrection } from '../../../tools/co-10919-correction.mjs';

after(closeDb);
const rollback = run => withTransaction(run, { rollback: true });
const photos = ['data:image/jpeg;base64,/9j/2Q==', 'data:image/jpeg;base64,/9j/4AAQ/9k='];

async function fixture() {
  const actor = crypto.randomUUID();
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,'CO correction test','test','test','operator',ARRAY['operator'],true)", [actor]);
  const sources = [await packingOrder({ quantity: 313.8, layers: 0, packed: 0 }), await packingOrder({ quantity: 251.04, layers: 4, packed: 0 })];
  const group = await packingGroup(sources);
  const children = [];
  for (const [index, so] of sources.entries()) {
    await query("UPDATE sales_orders SET outbound_location_id=28,outbound_location='2967',operator_status='open' WHERE netsuite_id=$1", [so.id]);
    await query("UPDATE sales_order_lines SET line_id=$2,item_id=4755,sku='EKO',pallet_qty=$3,to_plt=104.6,to_lyr=10.46,location_id=28,location='2967' WHERE id=$1", [so.lineId, index + 1, index ? 2 : 3]);
    children.push({ id: so.ref, type: 'SO', sourceYard: '2967', items: [{ lineRowId: Number(so.lineId), lineId: index + 1,
      itemId: 4755, sku: 'EKO', itemType: 'InvtPart', quantity: index ? 251.04 : 313.8,
      pallets: index ? 2 : 3, layers: index ? 4 : 0, toPlt: 104.6, toLyr: 10.46, unit: 'SQFT' }] });
  }
  const co = await upsertLocalCoOrder({ sourceOrderRef: group, fromYard: '2967', toYard: '3445', requestedBy: actor,
    order: { id: group, type: 'SO', childOrders: children.map(c => c.id), childOrderDetails: children, items: children.flatMap(c => c.items) } });
  await query("UPDATE co_orders SET status='completed' WHERE id=$1", [co.id]);
  const targets = [];
  for (const [index, so] of sources.entries()) {
    await query("UPDATE sales_orders SET operator_status='loaded',local_yard_order_status='Loaded' WHERE netsuite_id=$1", [so.id]);
    await query('UPDATE sales_order_lines SET loaded_qty=quantity WHERE id=$1', [so.lineId]);
    const load = (await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,source_table,
      source_record_id,operator_id,line_snapshot,photo_data_urls) VALUES('sales_order_delivery_load','sales_order',$1,$2,
      'sales_orders',$1,$3,$4::jsonb,$5::jsonb) RETURNING *`, [so.id, so.ref, actor,
      JSON.stringify([{ lineId: index + 1, itemId: 4755, loadedQty: index ? 251.04 : 313.8 }]), JSON.stringify(photos)])).rows[0];
    const candidate = (await query(`UPDATE dispatch_sales_order_if_candidates SET status='completed',completed_at=now(),
      netsuite_transaction_id=$2,netsuite_transaction_ref=$3 WHERE operator_load_record_id=$1 RETURNING *`,
    [load.id, 998880001 + index, `IF-TEST-${index}`])).rows[0];
    targets.push({ orderId: so.id, orderRef: so.ref, loadId: Number(load.id), ifId: 998880001 + index,
      ifRef: `IF-TEST-${index}`, candidateId: candidate.id, externalId: candidate.external_id });
  }
  return { actor, sources, group, scope: { key: `test-${co.id}`, coRef: co.co_ref, coId: Number(co.id), targets } };
}

test('a correction preview is read-only and retains the original load evidence', () => rollback(async () => {
  const f = await fixture();
  const before = await readCoTransferCorrection(f.scope);
  const plan = buildCoTransferCorrection(before, f.scope);
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.sourceLines.length, 2);
  assert.equal(plan.destinationYard, '3445');
  assert.deepEqual(await readCoTransferCorrection(f.scope), before);
}));

test('correction refuses a remaining NetSuite fulfillment and changes nothing', () => rollback(async () => {
  const f = await fixture(), before = await readCoTransferCorrection(f.scope);
  const plan = buildCoTransferCorrection(before, f.scope);
  await assert.rejects(applyCoTransferCorrection(plan, { lookupFulfillment: async id => ({ id }) }), /still exists/);
  assert.deepEqual(await readCoTransferCorrection(f.scope), before);
}));

test('correction preserves CO evidence, receipt packs at 3445, and the next customer load retains full quantities', () => rollback(async () => {
  const f = await fixture(), before = await readCoTransferCorrection(f.scope);
  const plan = buildCoTransferCorrection(before, f.scope);
  await applyCoTransferCorrection(plan, { lookupFulfillment: async () => null });
  const corrected = await readCoTransferCorrection(f.scope);
  assert.deepEqual(corrected.co, before.co);
  assert.deepEqual(corrected.cargo, before.cargo);
  assert.ok(corrected.orders.every(order => order.operator_status === 'open'));
  assert.ok(corrected.candidates.every(candidate => candidate.status === 'skipped'));
  for (const [index, load] of corrected.loads.entries()) {
    assert.equal(load.load_type, 'local_co_load');
    assert.equal(load.order_ref, f.scope.coRef);
    for (const field of ['created_at', 'operator_id', 'line_snapshot', 'photo_data_urls', 'source_table', 'source_record_id']) {assert.deepEqual(load[field], before.loads[index][field]);}
  }
  for (const source of f.sources) {assert.equal(Number((await packingState(source)).lines[0].loaded_qty), 0);}
  const receiving = await getLocalCoReceivingOrder(f.scope.coRef);
  for (const line of receiving.lines) {await confirmLocalCoReceivingLine(f.scope.coRef, line.id, { pallets: Number(line.pallet_qty), layers: Number(line.layer_qty) }, f.actor);}
  await receiveLocalCoOrder(f.scope.coRef, f.actor, { photoDataUrls: photos });
  const packed = await getDeliveryOrder(f.group);
  assert.equal(packed.operator_status, 'packed');
  assert.equal(Number(packed.outbound_location_id), 1);
  assert.equal(Number(packed.lines[0].packed_pallet_qty), 5);
  assert.equal(Number(packed.lines[0].packed_layer_qty), 4);
  await recordDeliveryLoad(f.group, f.actor, { photoDataUrls: photos });
  const next = (await query(`SELECT operator_load_snapshot FROM dispatch_sales_order_if_candidates
    WHERE source_sales_order_id=ANY($1::bigint[]) AND status='discovered' ORDER BY source_sales_order_id`, [f.sources.map(s => s.id)])).rows;
  assert.deepEqual(next.map(row => Number(row.operator_load_snapshot[0].quantity)), [313.8, 251.04]);
}));

test('a changed source quantity prevents applying a stale correction plan', () => rollback(async () => {
  const f = await fixture(), before = await readCoTransferCorrection(f.scope);
  const plan = buildCoTransferCorrection(before, f.scope);
  await query('UPDATE sales_order_lines SET loaded_qty=loaded_qty-1 WHERE id=$1', [f.sources[0].lineId]);
  const changed = await readCoTransferCorrection(f.scope);
  await assert.rejects(applyCoTransferCorrection(plan, { lookupFulfillment: async () => null }), /changed/);
  assert.deepEqual(await readCoTransferCorrection(f.scope), changed);
}));

test('an audit failure rolls the entire local correction back', () => rollback(async () => {
  const f = await fixture(), before = await readCoTransferCorrection(f.scope);
  const plan = buildCoTransferCorrection(before, f.scope);
  await query(`CREATE FUNCTION pg_temp.reject_transfer_correction() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'correction audit unavailable'; END $$`);
  await query(`CREATE TRIGGER reject_transfer_correction BEFORE INSERT ON dispatch_sales_order_if_audit_events
    FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_transfer_correction()`);
  await assert.rejects(applyCoTransferCorrection(plan, { lookupFulfillment: async () => null }), /correction audit unavailable/);
  assert.deepEqual(await readCoTransferCorrection(f.scope), before);
}));

test('repeating the same correction cannot erase later packing or change the evidence', () => rollback(async () => {
  const f = await fixture(), before = await readCoTransferCorrection(f.scope);
  const plan = buildCoTransferCorrection(before, f.scope);
  await applyCoTransferCorrection(plan, { lookupFulfillment: async () => null });
  const corrected = await readCoTransferCorrection(f.scope);
  await assert.rejects(applyCoTransferCorrection(plan, { lookupFulfillment: async () => null }), /changed/);
  assert.deepEqual(await readCoTransferCorrection(f.scope), corrected);
}));
