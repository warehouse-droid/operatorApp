import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { getDeliveryOrder, getDeliveryOrdersBatch, getFulfillableDeliveryOrder, buildItemFulfillmentPayload,
  recordDeliveryFulfillment } from '../../../src/delivery-repository.js';
import { prepareSalesOrderAutoFulfillmentCandidate } from '../../../src/sales-order-auto-fulfillment-repository.js';
import { createOperatorNetSuitePostingRealSourceResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { packingOrder } from '../../support/group-underpack-fixture.mjs';
import { transferPhysicalEvidence } from '../../support/to-physical-lines.mjs';

after(closeDb);
const scenario = run => withTransaction(run, { rollback: true });
async function fixture(transfer = false) {
  const value = await packingOrder({ transfer, quantity: 2, salesOnly: true, packed: 2 });
  const table = transfer ? 'transfer_order_lines' : 'sales_order_lines', column = transfer ? 'transfer_order_id' : 'sales_order_id';
  await query(`UPDATE ${table} SET piece_qty=2, packed_piece_qty=2, to_pcs=1, packed_sales_qty=0, netsuite_order_line=1 WHERE id=$1`, [value.lineId]);
  if(transfer)await query('UPDATE transfer_order_lines SET raw=$2::jsonb WHERE id=$1',[value.lineId,
    JSON.stringify(transferPhysicalEvidence({id:value.id,itemId:998190001,key:1,sourceLine:1,postingLine:2,quantity:2}))]);
  await query(`INSERT INTO ${table}(${column},line_id,netsuite_order_line,item_id,item_name,sku,item_type,
    quantity,unit,location_id,location,piece_qty,to_pcs,packed_piece_qty,netsuite_active${transfer ? ',line_stage' : ''})
    VALUES($1,9,9,9920,'Arbitrary resale service','RESALE-SERVICE','NonInvtPart',1,'EA',1,'3445',1,1,1,true${transfer ? ",'outbound'" : ''})`, [value.id]);
  return value;
}

async function automaticCandidate(value) {
  const event = (await query(`INSERT INTO dispatch_order_completion_events(order_kind,order_ref,dispatch_completed_at,
    completion_evidence_type,completion_evidence_id,actor_type,actor_id,reason)
    VALUES('SO',$1,now(),'driver_job',$2,'driver','test','') RETURNING id`, [value.ref, `test-${value.id}`])).rows[0];
  const gate = 'dispatch_netsuite_sales_order_if_3445';
  await query('UPDATE mbt_feature_flags SET enabled=true WHERE flag_key=$1', [gate]);
  await query(`INSERT INTO dispatch_sales_order_if_gate_watermarks(gate_key,gate_revision,activation_event_id,activated_at)
    VALUES($1,1,$2,now()) ON CONFLICT(gate_key) DO UPDATE SET activation_event_id=EXCLUDED.activation_event_id,activated_at=now()`, [gate, Number(event.id) - 1]);
  return (await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE completion_event_id=$1', [event.id])).rows[0];
}

test('noninventory remains visible in detail and batch but is excluded from fulfillable lines', async () => scenario(async () => {
  const value = await fixture();
  const detail = await getDeliveryOrder(value.id), batch = await getDeliveryOrdersBatch([value.id]);
  assert.deepEqual(detail.lines.map(l => l.item_type), ['InvtPart', 'NonInvtPart']);
  assert.deepEqual(batch[0].lines.map(l => l.item_type), ['InvtPart', 'NonInvtPart']);
  assert.deepEqual((await getFulfillableDeliveryOrder(value.id)).fulfillableLines.map(l => l.line_id), ['1']);
}));

test('real SO and TO stored-source queries exclude noninventory selection and deselection rows', async () => scenario(async () => {
  const source = createOperatorNetSuitePostingRealSourceResolver({ query, useStoredOrderLines: true });
  for (const transfer of [false, true]) {
    const value = await fixture(transfer), detail = await getDeliveryOrder(value.id);
    const resolved = await source(detail, { functionKey: 'delivery_prep' });
    assert.deepEqual(resolved.availableLines.map(l => l.orderLine), [transfer?2:1], detail.order_type);
    assert.equal(detail.lines.length, 2);
  }
}));

test('ignored resale rows cannot keep inventory fulfillment partial or acquire fulfilled quantities', async () => scenario(async () => {
  const value = await fixture(), detail = await getDeliveryOrder(value.id);
  const payload = buildItemFulfillmentPayload(detail, detail.lines.filter(l => l.item_type === 'InvtPart'));
  const result = await recordDeliveryFulfillment(value.id, null, { photoDataUrls: ['r2://test/a.jpg', 'r2://test/b.jpg'],
    payload, response: { test: true }, itemFulfillmentId: 777001, itemFulfillmentTranid: 'TEST-IF-001' });
  assert.equal(result.fulfillmentStatus, 'fulfilled');
  const refreshed = await getDeliveryOrder(value.id);
  assert.equal(Number(refreshed.lines.find(l => l.item_type === 'NonInvtPart').fulfilled_piece_qty), 0);
  assert.equal(Number(refreshed.lines.find(l => l.item_type === 'InvtPart').fulfilled_piece_qty), 2);
}));

test('future automatic fulfillment snapshots ignore resale rows while retaining loaded inventory evidence', async () => scenario(async () => {
  const value = await fixture();
  await query("UPDATE sales_orders SET operator_status='loaded',local_yard_order_status='Loaded' WHERE netsuite_id=$1", [value.id]);
  await query('UPDATE sales_order_lines SET loaded_qty=quantity WHERE sales_order_id=$1 AND item_type=$2', [value.id, 'InvtPart']);
  await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,line_snapshot,response)
    VALUES('sales_order_delivery_load','sales_order',$1,$2,$3::jsonb,'{}')`,
    [value.id, value.ref, JSON.stringify([{ lineId: 1, loadedQty: 2 }])]);
  const candidate = await automaticCandidate(value);
  const result = await prepareSalesOrderAutoFulfillmentCandidate(candidate.id);
  assert.equal(result.status, 'queued', result.lastError);
  assert.deepEqual(result.lineSnapshot.map(l => [l.orderLine, l.itemId, l.deliveredQuantity]), [[1, 998190001, 2]]);
  assert.equal((await getDeliveryOrder(value.id)).lines.length, 2);
}));

test('an automatic completion containing only resale items is skipped without an IF', async () => scenario(async () => {
  const value = await fixture();
  await query("UPDATE sales_order_lines SET item_type='NonInvtPart' WHERE sales_order_id=$1", [value.id]);
  const candidate = await automaticCandidate(value);
  const result = await prepareSalesOrderAutoFulfillmentCandidate(candidate.id);
  assert.equal(result.status, 'skipped', result.lastError);
  assert.deepEqual(result.lineSnapshot, []);
  assert.deepEqual(result.payload, {});
  assert.equal(result.netSuiteTransactionId, null);
}));
