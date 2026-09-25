// Run inside the application container. Default mode rehearses and rolls back.
// No remote NetSuite operations are imported or invoked.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { query, withTransaction, closeDb } from '/app/src/db.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '/app/src/dispatch-fleet-status.js';
import { lockConsolidatedLoadOrders } from '/app/src/consolidation-load-locks.js';
import { aggregateGlobalGroup } from '/app/src/dispatch-delivery-group-repository.js';
import { compactDispatchOrderCard, dispatchOrderSearchText } from '/app/src/dispatch-planner-optimization.js';
import { digestDispatchPlan, dispatchPlanBoard } from '/app/src/dispatch-planner-performance.js';
import { syncDispatchPlanOrderAssignments, syncDispatchPlanRelationEdges } from '/app/src/dispatch-planner-v2-repository.js';
import { getDispatchOrderCatalogOrder, listDispatchOrderPool } from '/app/src/dispatch-order-catalog-repository.js';
import { getDeliveryOrder } from '/app/src/delivery-repository.js';
import { writeDispatchAudit } from '/app/src/dispatch-audit-repository.js';

const target = Object.freeze({
  group: 'GOB-120921-121097', parent: 'SOB120921', first: 'SOB120921-S1', second: 'SOB120921-S2',
  other: 'SOB121097', planId: 336, date: '2026-09-24', load: 'T8-L1790198961120-f10c1a378bc0d8',
  orderIds: [-232732191565207, -192726939432163, 1003517, 1007957]
});
const refs = [target.parent, target.first, target.second, target.other];
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identities = items => items.map(item => [Number(item.lineId), Number(item.quantity)]).sort((a, b) => a[0] - b[0]);
const expectedFirst = [[4989721,868],[4989722,123],[4989723,54.18],[4989724,28],[4989725,216],[4989728,21],[4989729,1]];
const expectedSecond = [[4989722,246],[4989723,54.18],[4989728,5],[4989730,1]];

async function readState() {
  const plan = (await query(`SELECT p.id,p.plan_date::text AS "planDate",p.status,p.note,p.revision,
    s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
    WHERE p.id=$1 FOR UPDATE OF p,s`, [target.planId])).rows[0];
  const headers = (await query('SELECT * FROM sales_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id FOR UPDATE', [target.orderIds])).rows;
  const lines = (await query('SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY sales_order_id,line_id FOR UPDATE', [target.orderIds])).rows;
  const ledger = (await query('SELECT * FROM dispatch_scm_so_splits WHERE source_so_ref=$1 ORDER BY split_so_ref FOR UPDATE', [target.parent])).rows;
  const splits = (await query('SELECT * FROM dispatch_global_order_splits WHERE parent_order_ref=$1 ORDER BY split_ref FOR UPDATE', [target.parent])).rows;
  const global = (await query('SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1 FOR UPDATE', [target.group])).rows[0];
  const delivery = (await query('SELECT * FROM dispatch_delivery_groups WHERE group_ref=$1 FOR UPDATE', [target.group])).rows[0];
  const members = {};
  for (const table of ['dispatch_global_order_group_members', 'dispatch_delivery_group_members']) {
    members[table] = (await query(`SELECT * FROM ${table} WHERE group_ref=$1 ORDER BY position FOR UPDATE`, [target.group])).rows;
  }
  const assignments = (await query('SELECT * FROM dispatch_plan_order_assignments WHERE plan_id=$1 ORDER BY order_ref', [target.planId])).rows;
  const edges = (await query('SELECT * FROM dispatch_order_relation_edges WHERE plan_id=$1 ORDER BY relation_type,owner_ref,member_ref', [target.planId])).rows;
  const catalog = (await query('SELECT * FROM dispatch_order_catalog_entries WHERE order_ref=ANY($1::text[]) ORDER BY order_ref', [[...refs, target.group]])).rows;
  const loads = (await query('SELECT * FROM dispatch_plan_load_assignments WHERE plan_id=$1 ORDER BY load_id FOR UPDATE', [target.planId])).rows;
  return { plan, headers, lines, ledger, splits, global, delivery, members, assignments, edges, catalog, loads };
}

async function lockAndCheckIdle() {
  await query("SET LOCAL lock_timeout='5s'");
  await query("SET LOCAL statement_timeout='30s'");
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
  const leases = (await query('SELECT expires_at>now() AS active FROM dispatch_plan_edit_leases WHERE plan_date=$1::date FOR UPDATE', [target.date])).rows;
  assert.ok(leases.every(row => !row.active), 'Plan currently has an active editor; retry when idle');
  await lockConsolidatedLoadOrders([...target.orderIds, 'GROUP:' + target.group]);
  for (const ref of [...refs, target.group].sort()) {
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`dispatch-global-source-refresh:${ref.toLowerCase()}`]);
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`dispatch-global-order-definition:${ref.toLowerCase()}`]);
  }
}

async function validateState(state) {
  assert.equal(state.plan?.planDate, target.date);
  assert.equal(state.plan.status, 'confirmed');
  assert.equal(state.global?.active, true);
  assert.equal(state.delivery?.active, true);
  assert.equal(Number(state.delivery.plan_id), target.planId);
  assert.equal(state.delivery.truck_plate, 'CE94487');
  assert.equal(state.headers.length, 4);
  const second = state.headers.find(row => row.tranid === target.second);
  assert.equal(second.sales_order_type, 'Pick-Up');
  assert.ok(second.sales_order_type_override);
  assert.ok(state.headers.every(row => row.netsuite_active && row.operator_status === 'open' && row.fulfillment_status === 'not_fulfilled'));
  assert.ok(state.lines.every(row => row.netsuite_active));
  for (const line of state.lines) {
    for (const field of ['packed_sales_qty','packed_pallet_qty','packed_layer_qty','packed_section_qty','packed_piece_qty','loaded_qty']) {
      assert.equal(Number(line[field] || 0), 0, `Operational quantity changed: ${line.id}/${field}`);
    }
  }
  assert.deepEqual(state.ledger.map(row => [row.split_so_ref,row.status]), [[target.first,'active'],[target.second,'active']]);
  assert.deepEqual(state.splits.map(row => row.split_ref), [target.first,target.second]);
  assert.deepEqual(identities(state.splits[0].full_order.items), expectedFirst);
  assert.deepEqual(identities(state.splits[1].full_order.items), expectedSecond);
  assert.equal(state.splits[0].full_order.pallets, 21);
  assert.equal(state.splits[1].full_order.pallets, 5);
  for (const [ref, expected] of [[target.first,expectedFirst],[target.second,expectedSecond]]) {
    const header = state.headers.find(row => row.tranid === ref);
    assert.deepEqual(state.lines.filter(row => row.sales_order_id === header.netsuite_id)
      .map(row => [Number(row.line_id),Number(row.quantity)]), expected);
  }
  const load = state.loads.find(row => row.load_id === target.load);
  assert.ok(load && !load.started && !load.completed, 'Affected load has started');
  assert.equal((await query('SELECT 1 FROM driver_job_records WHERE plan_id=$1 AND load_id=$2 LIMIT 1', [target.planId,target.load])).rowCount, 0, 'Driver execution exists');
  assert.equal((await query('SELECT 1 FROM operator_load_records WHERE order_ref=ANY($1::text[]) LIMIT 1', [[...refs,target.group]])).rowCount, 0, 'Operator load evidence exists');
  const posting = await query("SELECT 1 FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing','pending') AND input_snapshot::text LIKE '%SOB120921%' LIMIT 1");
  assert.equal(posting.rowCount, 0, 'Posting command exists');
}

function withCorrectTotals(order) {
  const sales = new Map();
  for (const item of order.items) {
    const unit = String(item.unit || 'Qty').trim() || 'Qty';
    sales.set(unit, (sales.get(unit) || 0) + Number(item.quantity || 0));
  }
  return { ...order, itemCount: order.items.length,
    salesQuantities: [...sales].map(([unit,quantity]) => ({ unit, quantity: Number(quantity.toFixed(6)) })) };
}

function correctedGroup(current, first) {
  const children = current.childOrderDetails.map(child => child.id === target.parent ? first : child);
  assert.deepEqual(children.map(child => child.id), [target.first,target.other]);
  const corrected = withCorrectTotals(aggregateGlobalGroup(current, children));
  corrected.notes = String(current.notes || '').replace('Grouped orders: SOB120921,', 'Grouped orders: SOB120921-S1,');
  corrected.committedQty = children.reduce((sum, child) => sum + Number(child.committedQty || 0), 0);
  for (const field of ['address','destinationAddress','defaultDestinationAddress','expectedDeliveryDate','windowStart','windowEnd',
    'travelMinutes','unloadMinutes','stopMinutes']) {
    if (Object.hasOwn(current, field)) { corrected[field] = current[field]; }
  }
  assert.equal(corrected.pallets, 23);
  return corrected;
}

async function persist(state, nextPlan, first, second, global) {
  const plan = state.plan;
  const board = dispatchPlanBoard(plan);
  await query(`INSERT INTO dispatch_plan_snapshot_history
    (plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id,
     schema_version,plan_digest,order_count,truck_count,load_count,stop_count)
    VALUES ($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,'sob120921_split_group_repair',
      'authorized-sob120921-repair',2,$8,$9,$10,$11,$12)`,
  [plan.id,plan.planDate,plan.revision,JSON.stringify(plan.orders),JSON.stringify(plan.trucks),JSON.stringify(plan.summary),
    plan.saved_at,digestDispatchPlan(plan),plan.orders.length,board.truckCount,board.loadCount,board.stopCount]);
  for (const order of [first,second]) {
    await query(`UPDATE dispatch_global_order_splits SET active=true,full_order=$2::jsonb,card=$3::jsonb,
      search_text=$4,updated_at=now() WHERE split_ref=$1`,
    [order.id,JSON.stringify(order),JSON.stringify(compactDispatchOrderCard(order)),dispatchOrderSearchText(order)]);
  }
  await query(`UPDATE dispatch_global_order_groups SET full_order=$2::jsonb,card=$3::jsonb,search_text=$4,
    source_revision=$5,updated_at=now() WHERE group_ref=$1`,
  [target.group,JSON.stringify(global),JSON.stringify(compactDispatchOrderCard(global)),dispatchOrderSearchText(global),nextPlan.revision]);
  for (const table of ['dispatch_global_order_group_members','dispatch_delivery_group_members']) {
    const changed = await query(`UPDATE ${table} SET member_order_ref=$2 WHERE group_ref=$1 AND member_order_ref=$3`,
      [target.group,target.first,target.parent]);
    assert.equal(changed.rowCount, 1, 'Expected exactly one member replacement');
  }
  const changed = await query('UPDATE dispatch_plans SET revision=$2,updated_at=now() WHERE id=$1 AND revision=$3',
    [plan.id,nextPlan.revision,plan.revision]);
  assert.equal(changed.rowCount, 1, 'Plan revision changed');
  await query(`UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,plan_digest=$3,saved_at=now()
    WHERE plan_id=$1`, [plan.id,JSON.stringify(nextPlan.orders),digestDispatchPlan(nextPlan)]);
  await syncDispatchPlanOrderAssignments(nextPlan);
  await syncDispatchPlanRelationEdges(nextPlan);
  await query('DELETE FROM dispatch_order_catalog_entries WHERE order_ref=ANY($1::text[])', [[target.group,target.first,target.second]]);
  await query(`UPDATE dispatch_order_catalog_state SET generation=generation+1,
    catalog_count=(SELECT count(*) FROM dispatch_order_catalog_entries),updated_at=now() WHERE singleton=true`);
}

async function verify(state, nextPlan) {
  const after = await readState();
  assert.deepEqual(after.headers, state.headers, 'Source order headers changed');
  assert.deepEqual(after.lines, state.lines, 'Source or split quantities changed');
  assert.deepEqual(after.ledger, state.ledger, 'Operational split ledger changed');
  assert.deepEqual(after.loads, state.loads, 'Truck/load assignments changed');
  assert.deepEqual(after.plan.trucks, state.plan.trucks, 'Stops changed');
  assert.deepEqual(after.plan.summary, state.plan.summary, 'Summary changed');
  assert.deepEqual(after.plan.orders, nextPlan.orders);
  assert.equal(Number(after.plan.revision), Number(nextPlan.revision));
  assert.ok(after.splits.every(row => row.active), 'Split definitions were not restored');
  assert.deepEqual(identities(after.splits[0].full_order.items), expectedFirst);
  assert.deepEqual(identities(after.splits[1].full_order.items), expectedSecond);
  for (const rows of Object.values(after.members)) { assert.deepEqual(rows.map(row => row.member_order_ref), [target.first,target.other]); }
  const mapped = after.assignments.filter(row => row.planned_order_ref === target.group);
  assert.equal(mapped.find(row => row.order_ref === target.parent)?.assignment_kind, 'split_parent_alias');
  assert.equal(mapped.find(row => row.order_ref === target.first)?.assignment_kind, 'group_member');
  assert.ok(!mapped.some(row => row.order_ref === target.second));
  const unchanged = rows => rows.filter(row => row.planned_order_ref !== target.group).map(({updated_at: _updatedAt,...row}) => row);
  assert.deepEqual(unchanged(after.assignments), unchanged(state.assignments), 'Unrelated assignments changed');
  const catalog = await getDispatchOrderCatalogOrder(target.group);
  assert.equal(catalog.pallets, 23);
  assert.deepEqual(catalog.childOrders, [target.first,target.other]);
  const pool = await listDispatchOrderPool({ type: 'SO', search: target.parent });
  const poolOrders = pool.orders || pool;
  assert.ok(!poolOrders.some(row => row.id === target.parent), 'Full parent reappeared in pool');
  const delivery = await getDeliveryOrder('GROUP:' + target.group);
  assert.deepEqual(delivery.child_orders.map(row => row.tranid).sort(), [target.first,target.other].sort());
  const first = delivery.child_orders.find(row => row.tranid === target.first);
  const loadableFirst = expectedFirst.filter(([lineId]) => lineId !== 4989729);
  assert.deepEqual(first.lines.filter(line => line.netsuite_active).map(line => [Number(line.line_id),Number(line.quantity)]).sort((a,b) => a[0]-b[0]), loadableFirst);
  return { pallets: catalog.pallets, members: catalog.childOrders, pickupMethod: after.headers.find(row => row.tranid === target.second).sales_order_type,
    sourceAndSplitQuantitiesPreserved: true, truckAndStopsPreserved: true, operatorGroupUsesSplit: true, parentHidden: true };
}

async function repair({ apply = false, expectedFingerprint = '', backupPath = '' } = {}) {
  return withTransaction(async () => {
    await lockAndCheckIdle();
    const state = await readState();
    await validateState(state);
    const current = state.plan.orders.filter(order => order.id === target.group);
    assert.equal(current.length, 1);
    if (current[0].childOrders.includes(target.first) && !current[0].childOrders.includes(target.parent)) {
      const checks = await verify(state, state.plan);
      return { alreadyCorrect: true, applied: false, revision: Number(state.plan.revision), checks };
    }
    assert.deepEqual(current[0].childOrders, [target.parent,target.other]);
    assert.deepEqual(state.global.full_order.childOrders, [target.parent,target.other]);
    assert.equal(current[0].pallets, 28);
    assert.equal(state.global.full_order.pallets, 28);
    assert.ok(state.splits.every(row => !row.active));
    const beforeFingerprint = fingerprint(state);
    if (apply) {
      assert.equal(expectedFingerprint, beforeFingerprint, 'Incident state changed; rehearse again');
      assert.ok(backupPath, 'A private backup path is required');
      await fs.writeFile(backupPath, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    }
    const first = withCorrectTotals(structuredClone(state.splits[0].full_order));
    const second = withCorrectTotals(structuredClone(state.splits[1].full_order));
    const global = correctedGroup(state.global.full_order, first);
    const nextPlan = { ...state.plan, revision: Number(state.plan.revision)+1,
      orders: state.plan.orders.map(order => order.id === target.group ? correctedGroup(order, first) : order) };
    await persist(state, nextPlan, first, second, global);
    const checks = await verify(state, nextPlan);
    const audit = await writeDispatchAudit({ action: 'dispatch.sob120921_split_group_repaired', entityType: 'order',
      entityId: target.group, orderId: target.parent, planId: target.planId, planDate: target.date,
      source: 'authorized-split-group-repair', operatorName: 'system:authorized-repair',
      before: { group: current[0], splits: state.splits, members: state.members },
      after: { group: nextPlan.orders.find(order => order.id === target.group), checks },
      details: { beforeFingerprint, oldRevision: Number(state.plan.revision), newRevision: nextPlan.revision,
        reason: 'Restore valid split definitions incorrectly retired during a truck-change save; group S1 only.' } });
    return { applied: apply, rolledBack: !apply, beforeFingerprint, oldRevision: Number(state.plan.revision),
      newRevision: nextPlan.revision, auditId: audit.id, checks };
  }, { rollback: !apply });
}

try {
  const options = JSON.parse(process.env.SOB120921_REPAIR_OPTIONS || '{}');
  const result = await repair(options);
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
