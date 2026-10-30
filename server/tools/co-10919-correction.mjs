import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const source = name => pathToFileURL(path.resolve('src', name)).href;
const { query, withTransaction } = await import(source('db.js'));
const { lockConsolidatedLoadOrders } = await import(source('consolidation-load-locks.js'));
const { writeAudit } = await import(source('auth-repository.js'));
const rows = async (sql, values = []) => (await query(sql, values)).rows;
const plain = value => JSON.parse(JSON.stringify(value));
const units = ['pallet', 'layer', 'section', 'piece', 'sales'];
const numeric = value => Number(value || 0);
const pick = (row, fields) => Object.fromEntries(fields.map(field => [field, row[field] ?? null]));
export const CO_TRANSFER_SCOPE = Object.freeze({ key: 'co-10919-10923-transfer-correction-20261027',
  coRef: 'CO-GOA-10919-10923', coId: 197, targets: [
    { orderId: 1094559, orderRef: 'SOA10919', loadId: 7159, ifId: 1095903, ifRef: 'IF159803',
      candidateId: 'a0d7ca01-7cd4-442c-af4d-cd1c2580c1dd', externalId: 'MBBS-SOIF-a0d7ca01-7cd4-442c-af4d-cd1c2580c1dd' },
    { orderId: 1094575, orderRef: 'SOA10923', loadId: 7160, ifId: 1096033, ifRef: 'IF159804',
      candidateId: 'df0e0078-93ee-4ba4-acc9-05ca6c6e92dd', externalId: 'MBBS-SOIF-df0e0078-93ee-4ba4-acc9-05ca6c6e92dd' }
  ] });

function fingerprint(state) {
  const stable = { ...plain(state), orders: state.orders.map(row => pick(row,
    ['netsuite_id', 'tranid', 'operator_status', 'local_yard_order_status', 'outbound_location_id', 'preparing_operator_id'])) };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export async function readCoTransferCorrection(scope = CO_TRANSFER_SCOPE) {
  const ids = scope.targets.map(t => t.orderId);
  return plain({
    co: (await rows('SELECT * FROM local_co_orders WHERE id=$1 AND co_ref=$2', [scope.coId, scope.coRef]))[0],
    cargo: await rows('SELECT * FROM local_co_order_lines WHERE co_id=$1 ORDER BY id', [scope.coId]),
    orders: await rows('SELECT * FROM sales_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id', [ids]),
    lines: await rows('SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id', [ids]),
    loads: await rows('SELECT * FROM operator_load_records WHERE id=ANY($1::bigint[]) ORDER BY id', [scope.targets.map(t => t.loadId)]),
    candidates: await rows('SELECT * FROM dispatch_sales_order_if_candidates WHERE source_sales_order_id=ANY($1::bigint[]) ORDER BY id', [ids]),
    claims: await rows('SELECT * FROM dispatch_sales_order_if_line_claims WHERE source_sales_order_id=ANY($1::bigint[]) ORDER BY candidate_id,source_line_id', [ids]),
    postingClaims: await rows('SELECT * FROM operator_netsuite_posting_order_claims WHERE active AND local_order_key=ANY($1::text[])',
      [ids.map(id => `delivery_prep:sales_order:${id}`)]),
    reloads: await rows('SELECT * FROM operator_reload_cycles WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id', [ids])
  });
}

export function buildCoTransferCorrection(state, scope = CO_TRANSFER_SCOPE) {
  assert.equal(state.co?.co_ref, scope.coRef);
  assert.equal(Number(state.co.id), scope.coId);
  assert.equal(state.co.status, 'completed');
  assert.equal(state.co.received_at, null, 'CO already received');
  assert.equal(Number(state.co.to_location_id), 1);
  assert.equal(state.orders.length, 2);
  assert.equal(state.loads.length, 2);
  assert.equal(state.candidates.length, 2, 'Additional fulfillment activity exists');
  assert.equal(state.postingClaims.length + state.reloads.length, 0, 'Active posting or reload exists');
  assert.ok(state.claims.every(claim => !claim.active), 'Active fulfillment claims exist');
  const sourceLines = state.cargo.map(cargo => {
    const line = state.lines.find(row => String(row.id) === String(cargo.raw?.lineRowId));
    assert.ok(line, 'Original source line is missing');
    assert.equal(String(line.item_id), String(cargo.item_id));
    assert.equal(Number(line.quantity), Number(cargo.quantity));
    assert.equal(Number(line.loaded_qty), Number(cargo.quantity), 'Source quantity changed');
    assert.ok(units.every(unit => numeric(line[`packed_${unit}_qty`]) === 0), 'Source has new packing');
    assert.ok(units.every(unit => numeric(line[`fulfilled_${unit}_qty`]) === 0), 'Source has independent fulfilled units');
    return { id: line.id, orderId: line.sales_order_id, lineId: line.line_id, itemId: line.item_id, quantity: numeric(line.loaded_qty) };
  });
  assert.equal(new Set(sourceLines.map(line => line.id)).size, sourceLines.length);
  for (const target of scope.targets) {
    const order = state.orders.find(row => Number(row.netsuite_id) === target.orderId);
    assert.equal(order?.tranid, target.orderRef);
    assert.equal(order.operator_status, 'loaded');
    const load = state.loads.find(row => Number(row.id) === target.loadId);
    assert.equal(load?.order_ref, target.orderRef);
    assert.equal(load.load_type, 'sales_order_delivery_load');
    assert.equal(load.order_family, 'sales_order');
    assert.equal(Number(load.order_id), target.orderId);
    const candidate = state.candidates.find(row => row.id === target.candidateId);
    assert.equal(candidate?.status, 'completed');
    assert.equal(Number(candidate.netsuite_transaction_id), target.ifId);
    assert.equal(candidate.netsuite_transaction_ref, target.ifRef);
    assert.equal(candidate.external_id, target.externalId);
    assert.equal(Number(candidate.operator_load_record_id), target.loadId);
    const saved = load.line_snapshot.filter(line => numeric(line.loadedQty) > 0);
    const original = sourceLines.filter(line => Number(line.orderId) === target.orderId);
    assert.equal(saved.length, original.length);
    for (const line of original) {
      const match = saved.find(row => String(row.lineId) === String(line.lineId) && String(row.itemId) === String(line.itemId));
      assert.equal(numeric(match?.loadedQty), line.quantity, 'Load evidence quantity changed');
    }
  }
  return { ...plain(scope), expected: fingerprint(state), destinationYard: '3445', sourceLines,
    coDeliveryId: state.co.delivery_order_id, reason: 'User confirmed CO transfer to 3445 before customer delivery; remove the misclassified SO load.' };
}

export async function applyCoTransferCorrection(plan, options = {}) {
  if (options.lookupFulfillment) {assert.equal(process.env.MBT_TEST_ISOLATED, '1', 'Test boundary is isolated only');}
  const lookup = options.lookupFulfillment || (await import(source('netsuite.js'))).fetchItemFulfillmentFromNetSuite;
  return withTransaction(async () => {
    await lockConsolidatedLoadOrders([plan.coDeliveryId, ...plan.targets.map(t => t.orderId)]);
    await query('SELECT id FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [plan.targets.map(t => t.orderId)]);
    await query('SELECT id FROM operator_load_records WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [plan.targets.map(t => t.loadId)]);
    const before = await readCoTransferCorrection(plan);
    assert.equal(fingerprint(before), plan.expected, 'Correction source changed; refresh the preview');
    buildCoTransferCorrection(before, plan);
    for (const target of plan.targets) {assert.equal(await lookup(target.ifId), null, `${target.ifRef} still exists in NetSuite`);}
    for (const target of plan.targets) {
      const original = before.loads.find(load => Number(load.id) === target.loadId);
      await query(`UPDATE operator_load_records SET load_type='local_co_load',order_family='co_order',order_id=$2,
        order_ref=$3,response=response||$4::jsonb WHERE id=$1`,
      [target.loadId, plan.coDeliveryId, plan.coRef, JSON.stringify({ coRef: plan.coRef,
        correction: { key: plan.key, coId: plan.coId, originalOrderId: original.order_id, originalOrderRef: original.order_ref, reason: plan.reason } })]);
      await query(`UPDATE dispatch_sales_order_if_candidates SET status='skipped',completed_at=NULL,
        resolution_action='skip',resolution_reason=$2,resolved_by='co-transfer-correction',resolved_at=now(),updated_at=now(),
        result=result||$3::jsonb WHERE id=$1`, [target.candidateId, plan.reason,
        JSON.stringify({ coTransferCorrection: { key: plan.key, deletedFulfillment: target.ifRef,
          originalCompletedAt: before.candidates.find(row => row.id === target.candidateId).completed_at } })]);
      await query(`INSERT INTO dispatch_sales_order_if_audit_events(candidate_id,action,details)
        VALUES($1,'co_transfer_load_corrected',$2::jsonb)`, [target.candidateId, JSON.stringify({ key: plan.key, coRef: plan.coRef, target })]);
    }
    await query(`UPDATE sales_order_lines SET loaded_qty=0,confirmed=false,confirmed_at=NULL WHERE id=ANY($1::bigint[])`, [plan.sourceLines.map(line => line.id)]);
    await query(`UPDATE sales_orders SET operator_status='open',local_yard_order_status='Open',preparing_operator_id=NULL,
      preparing_started_at=NULL,status_updated_at=now(),fulfillment_status='not_fulfilled',last_item_fulfillment_id=NULL,
      last_item_fulfillment_tranid=NULL,fulfilled_at=NULL WHERE netsuite_id=ANY($1::bigint[])`, [plan.targets.map(t => t.orderId)]);
    await writeAudit({ source: 'co_transfer_correction', action: 'delivery.co_transfer_load.correct', orderId: plan.coDeliveryId,
      details: { key: plan.key, reason: plan.reason, sourceLines: plan.sourceLines, originalLoads: before.loads,
        targets: plan.targets, receiptRecorded: false } });
    const after = await readCoTransferCorrection(plan);
    assert.deepEqual(after.co, before.co);
    assert.deepEqual(after.cargo, before.cargo);
    return { corrected: true, coRef: plan.coRef, sourceOrders: plan.targets.map(t => t.orderRef),
      destinationYard: plan.destinationYard, status: 'awaiting CO receiving; receipt will mark Packed', receiptRecorded: false };
  });
}
