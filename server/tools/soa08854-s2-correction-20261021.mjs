// Operational repair; run via stdin from /app. Default is a read-only preview.
// No NetSuite reads or writes. Original Driver and plan snapshots remain evidence.
import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from './src/db.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from './src/dispatch-fleet-status.js';
import { lockConsolidatedLoadOrders } from './src/consolidation-load-locks.js';
import { compactDispatchOrderCard, dispatchOrderSearchText } from './src/dispatch-planner-optimization.js';
import { aggregateGlobalGroup } from './src/dispatch-delivery-group-repository.js';
import { writeDispatchAudit } from './src/dispatch-audit-repository.js';

const APPLY = process.argv.includes('--apply');
const REF = 'SOA08854-S2', ORDER = '-193327159321438', LINE = '-143231027623399';
const GROUP = 'GOA-8854S2-8855S2', CANDIDATE = '4c5a18fd-c439-41d2-b5e0-3b44d0496ebe';
const ACTION = 'delivery.quantity.user_corrected', KEY = 'soa08854-s2-actual-20261021';
const ACTOR = 'maintenance:soa08854-s2-correction-20261021';
const REASON = 'User confirmed SOA08854-S2 actually delivered 9 pallets and 5 layers of Fossil and requested correction. Preserve the separate 2-layer IF at yard 2967. Transaction type for the requested IR is awaiting clarification.';
const QTY = 993.7, PARENT_LOADED = 3190.3;

async function protectedState() {
  return (await query(`SELECT
    (SELECT md5(jsonb_agg(to_jsonb(j) ORDER BY id)::text) FROM driver_job_records j WHERE order_refs ?| ARRAY['SOA08854','SOA08854-S1','SOA08854-S2']) driver,
    (SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY plan_id)::text) FROM dispatch_plan_snapshots p WHERE plan_id IN(359,363)) plans,
    (SELECT md5(jsonb_agg(to_jsonb(o) ORDER BY netsuite_id)::text) FROM sales_orders o WHERE tranid IN('SOA08854','SOA08854-S1') OR tranid LIKE 'SOA08855%') other_headers,
    (SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY l.id)::text) FROM sales_order_lines l JOIN sales_orders o ON o.netsuite_id=l.sales_order_id WHERE (o.tranid IN('SOA08854','SOA08854-S1') OR o.tranid LIKE 'SOA08855%') AND l.id<>455278) other_lines,
    (SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY split_ref)::text) FROM dispatch_global_order_splits s WHERE split_ref='SOA08854-S1' OR split_ref LIKE 'SOA08855%') other_splits,
    (SELECT md5(to_jsonb(c)::text) FROM dispatch_sales_order_if_candidates c WHERE id=$1) posting
  `, [CANDIDATE])).rows[0];
}

function corrected(order, correction) {
  assert.equal(order.id, REF);
  assert.equal(order.items.length, 1);
  const item = order.items[0];
  assert.equal(Number(item.itemId), 10374);
  assert.equal(Number(item.lineId), 4968392);
  assert.equal(Number(item.quantity), 1328.42);
  assert.equal(Number(item.pallets), 12);
  assert.equal(Number(item.layers), 7);
  const next = structuredClone(order);
  next.items[0] = { ...item, quantity: QTY, splitQty: QTY, pallets: 9, layers: 5,
    splitUnit: '9 PLT 5 LYR', lineWeight: Number((QTY * Number(item.itemWeight)).toFixed(6)) };
  next.salesQty = QTY;
  next.salesQuantities = [{ unit: 'SQFT', quantity: QTY }];
  next.pallets = 10; // Dispatch pallet-space total: nine full pallets plus the partial pallet.
  next.weight = Number((QTY * Number(item.itemWeight)).toFixed(2));
  next.operatorStatus = 'loaded';
  next.localYardOrderStatus = 'Loaded';
  next.deliveryQuantityCorrection = correction;
  return next;
}

async function work() {
  await query(APPLY ? 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ' : 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await query("SET LOCAL lock_timeout='5s'");
  await query("SET LOCAL statement_timeout='15s'");
  if (APPLY) {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
    await lockConsolidatedLoadOrders([995609, ORDER]);
  }
  const lock = APPLY ? ' FOR UPDATE' : '';
  const header = (await query('SELECT * FROM sales_orders WHERE netsuite_id=$1' + lock, [ORDER])).rows[0];
  const line = (await query('SELECT * FROM sales_order_lines WHERE id=$1' + lock, [LINE])).rows[0];
  const parent = (await query('SELECT * FROM sales_order_lines WHERE id=455278' + lock)).rows[0];
  const split = (await query('SELECT * FROM dispatch_global_order_splits WHERE split_ref=$1' + lock, [REF])).rows[0];
  const group = (await query('SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1' + lock, [GROUP])).rows[0];
  const candidate = (await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE id=$1' + lock, [CANDIDATE])).rows[0];
  const previous = (await query("SELECT id,details FROM delivery_audit_log WHERE order_id=$1 AND action=$2 AND details->>'correctionKey'=$3", [ORDER, ACTION, KEY])).rows;
  if (previous.length) {
    assert.equal(previous.length, 1);
    assert.equal(Number(line.quantity), QTY);
    assert.equal(Number(line.loaded_qty), QTY);
    assert.equal(Number(parent.loaded_qty), PARENT_LOADED);
    assert.equal(split.full_order.items[0].quantity, QTY);
    assert.equal(group.full_order.childOrderDetails.find(o => o.id === REF).items[0].quantity, QTY);
    return { alreadyApplied: true, orderRef: REF, quantity: QTY, pallets: 9, layers: 5, auditId: previous[0].id, netSuiteWrite: false };
  }
  assert.equal(header.tranid, REF);
  assert.equal(header.operator_status, 'open');
  assert.equal(header.last_item_fulfillment_id, null);
  assert.equal(header.fulfillment_status, 'not_fulfilled');
  assert.equal(line.sales_order_id, ORDER);
  assert.equal(Number(line.item_id), 10374);
  assert.equal(Number(line.line_id), 4968392);
  assert.equal(line.unit, 'SQFT');
  assert.equal(Number(line.quantity), 1328.42);
  assert.equal(Number(line.pallet_qty), 12);
  assert.equal(Number(line.layer_qty), 7);
  assert.equal(line.loaded_qty, null);
  assert.equal(Number((9 * Number(line.to_plt) + 5 * Number(line.to_lyr)).toFixed(2)), QTY);
  assert.equal(Number(parent.sales_order_id), 995609);
  assert.equal(Number(parent.item_id), 10374);
  assert.equal(Number(parent.quantity), 3420.42);
  assert.equal(Number(parent.loaded_qty), 2196.6);
  assert.equal(Number((Number(parent.loaded_qty) + QTY).toFixed(2)), PARENT_LOADED);
  assert.equal(split.active, true);
  assert.equal(group.active, true);
  assert.equal(candidate.status, 'skipped');
  assert.equal(candidate.attempt_count, 0);
  assert.equal(candidate.lease_token, null);
  assert.equal(candidate.netsuite_transaction_id, null);
  assert.deepEqual(candidate.line_snapshot, []);
  assert.equal((await query('SELECT 1 FROM dispatch_sales_order_if_line_claims WHERE source_sales_order_id=995609 AND active')).rowCount, 0);
  assert.equal((await query(`SELECT 1 FROM operator_netsuite_posting_order_claims WHERE active AND local_order_key=ANY($1::text[])`,
    [[`delivery_prep:sales_order:${ORDER}`, `customer_pickup:sales_order:${ORDER}`, 'delivery_prep:sales_order:995609']])).rowCount, 0);
  const driver = (await query('SELECT id,status,stop_type,order_refs,completed_at FROM driver_job_records WHERE id=6822')).rows[0];
  assert.equal(driver.status, 'complete');
  assert.equal(driver.stop_type, 'dropoff');
  assert.ok(driver.order_refs.includes(REF));
  assert.equal(driver.completed_at.toISOString(), '2026-10-19T17:29:15.946Z');
  const correction = { key: KEY, actor: ACTOR, reason: REASON, evidence: 'user_confirmed_actual_delivery',
    originalPlannedQuantity: 1328.42, actualQuantity: QTY, unit: 'SQFT', pallets: 9, layers: 5,
    driverJobRecordId: 6822, originalDriverSnapshotRetained: true, correctedAt: new Date().toISOString() };
  const nextSplit = corrected(split.full_order, correction);
  const children = group.full_order.childOrderDetails;
  assert.equal(children.filter(o => o.id === REF).length, 1);
  const nextGroup = aggregateGlobalGroup(group.full_order, children.map(o => o.id === REF ? corrected(o, correction) : o));
  assert.deepEqual(nextGroup.childOrderDetails.filter(o => o.id !== REF), children.filter(o => o.id !== REF));
  assert.deepEqual(nextGroup.items.filter(o => Number(o.itemId) !== 10374), group.full_order.items.filter(o => Number(o.itemId) !== 10374));
  const before = { header, line, parent, split, group, candidate };
  const protectedBefore = await protectedState();
  if (!APPLY) return { applied: false, preview: true, before, protectedBefore, proposed: correction,
    parentLoaded: PARENT_LOADED, localRemainder: 230.12, netSuiteWrite: false };
  await query('UPDATE sales_order_lines SET quantity=$2,pallet_qty=9,layer_qty=5,loaded_qty=$2,loaded_uom=unit WHERE id=$1', [LINE, QTY]);
  await query('UPDATE sales_order_lines SET loaded_qty=$1,loaded_uom=unit WHERE id=455278', [PARENT_LOADED]);
  await query("UPDATE sales_orders SET operator_status='loaded',local_yard_order_status='Loaded',status_updated_at=now() WHERE netsuite_id=$1", [ORDER]);
  for (const [table, column, ref, order] of [
    ['dispatch_global_order_splits','split_ref',REF,nextSplit], ['dispatch_global_order_groups','group_ref',GROUP,nextGroup]
  ]) await query(`UPDATE ${table} SET full_order=$2::jsonb,card=$3::jsonb,search_text=$4,updated_at=now() WHERE ${column}=$1`,
    [ref, JSON.stringify(order), JSON.stringify(compactDispatchOrderCard(order)), dispatchOrderSearchText(order)]);
  await query('DELETE FROM dispatch_order_catalog_entries WHERE order_ref=ANY($1::text[])', [[REF,GROUP]]);
  await query('UPDATE dispatch_order_catalog_state SET generation=generation+1,catalog_count=(SELECT count(*)::int FROM dispatch_order_catalog_entries),updated_at=now() WHERE singleton=true');
  const after = { header: (await query('SELECT * FROM sales_orders WHERE netsuite_id=$1', [ORDER])).rows[0],
    line: (await query('SELECT * FROM sales_order_lines WHERE id=$1', [LINE])).rows[0],
    parent: (await query('SELECT * FROM sales_order_lines WHERE id=455278')).rows[0], split: nextSplit, group: nextGroup };
  assert.deepEqual({ ...after.line, quantity: line.quantity, pallet_qty: line.pallet_qty, layer_qty: line.layer_qty,
    loaded_qty: line.loaded_qty, loaded_uom: line.loaded_uom }, line);
  assert.deepEqual({ ...after.parent, loaded_qty: parent.loaded_qty, loaded_uom: parent.loaded_uom }, parent);
  assert.deepEqual({ ...after.header, operator_status: header.operator_status, local_yard_order_status: header.local_yard_order_status,
    status_updated_at: header.status_updated_at }, header);
  assert.deepEqual(await protectedState(), protectedBefore);
  const details = { correctionKey: KEY, ...correction, before, after, netSuiteWrite: false,
    protectedBefore, parentLoaded: PARENT_LOADED, localRemainder: 230.12, postingStillSkipped: true };
  const audit = (await query(`INSERT INTO delivery_audit_log(actor_type,source,action,order_id,line_id,details)
    VALUES('system','authorized-quantity-correction',$1,$2,$3,$4::jsonb) RETURNING id`, [ACTION, ORDER, LINE, JSON.stringify(details)])).rows[0];
  const dispatchAudit = await writeDispatchAudit({ action: ACTION, entityType: 'sales_order', entityId: ORDER,
    orderId: REF, operatorName: ACTOR, source: 'authorized-quantity-correction', before: split.full_order, after: nextSplit,
    details: { correctionKey: KEY, deliveryAuditId: audit.id, ...correction } });
  return { applied: true, orderRef: REF, quantity: QTY, pallets: 9, layers: 5, parentLoaded: PARENT_LOADED,
    localRemainder: 230.12, auditId: audit.id, dispatchAuditId: dispatchAudit.id, netSuiteWrite: false,
    protectedStateUnchanged: true, before, after };
}
try { console.log(JSON.stringify(await withTransaction(work))); } finally { await closeDb(); }
