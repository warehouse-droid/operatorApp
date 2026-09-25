// Authorized one-time rename. Default execution rehearses and rolls back.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { query, withTransaction, closeDb } from '/app/src/db.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '/app/src/dispatch-fleet-status.js';
import { lockConsolidatedLoadOrders } from '/app/src/consolidation-load-locks.js';
import { compactDispatchOrderCard, dispatchOrderSearchText } from '/app/src/dispatch-planner-optimization.js';
import { digestDispatchPlan, dispatchPlanBoard } from '/app/src/dispatch-planner-performance.js';
import { syncDispatchPlanOrderAssignments, syncDispatchPlanRelationEdges } from '/app/src/dispatch-planner-v2-repository.js';
import { getDispatchOrderCatalogOrder, listDispatchOrderPool } from '/app/src/dispatch-order-catalog-repository.js';
import { getDeliveryOrder } from '/app/src/delivery-repository.js';
import { writeDispatchAudit } from '/app/src/dispatch-audit-repository.js';

const oldRef = 'GOB-120921-121097', newRef = 'GOB-120921S1-121097';
const parent = 'SOB120921', first = 'SOB120921-S1', second = 'SOB120921-S2';
const ids = [-232732191565207, -192726939432163, 1003517, 1007957];
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function replaceRef(value, from = oldRef, to = newRef) {
  if (value instanceof Date) { return new Date(value); }
  if (Array.isArray(value)) { return value.map(item => replaceRef(item, from, to)); }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key === from ? to : key, replaceRef(item, from, to)]));
  }
  return value === from ? to : value === 'GROUP:' + from ? 'GROUP:' + to : value;
}

async function auditNames() {
  const browser = await fs.readFile('/app/public/dispatch.js', 'utf8');
  const context = vm.createContext({});
  vm.runInContext(browser.slice(browser.indexOf('function groupedDispatchOrderId('), browser.indexOf('function dispatchOrderIdExists(')), context);
  const rows = (await query(`SELECT group_ref,order_type,full_order->'childOrders' AS members
    FROM dispatch_global_order_groups WHERE active=true ORDER BY group_ref`)).rows;
  const splitGroups = rows.filter(row => row.members?.some(ref => /-S\d+$/i.test(ref)));
  const missing = splitGroups.filter(row => row.members.some(ref => {
    const match = ref.match(/(\d+)-S(\d+)$/i);
    return match && !row.group_ref.toUpperCase().split('-').includes(`${Number(match[1])}S${match[2]}`);
  })).map(row => ({ oldRef: row.group_ref,
    newRef: context.groupedDispatchOrderId(row.members.map(id => ({ id, type: row.order_type }))) }));
  return { inspectedActiveSplitGroups: splitGroups.length, missing };
}

async function readState() {
  const plan = (await query(`SELECT p.id,p.plan_date::text AS "planDate",p.status,p.note,p.revision,
    s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
    WHERE p.id=336 FOR UPDATE OF p,s`)).rows[0];
  const headers = (await query('SELECT * FROM sales_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id FOR UPDATE', [ids])).rows;
  const lines = (await query('SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY sales_order_id,line_id FOR UPDATE', [ids])).rows;
  const state = { plan, headers, lines };
  for (const table of ['dispatch_global_order_groups','dispatch_delivery_groups','dispatch_global_order_group_members','dispatch_delivery_group_members']) {
    state[table] = (await query(`SELECT * FROM ${table} WHERE group_ref=ANY($1::text[]) ORDER BY group_ref,to_jsonb(${table})::text FOR UPDATE`, [[oldRef,newRef]])).rows;
  }
  state.splits = (await query('SELECT * FROM dispatch_global_order_splits WHERE parent_order_ref=$1 ORDER BY split_ref FOR UPDATE', [parent])).rows;
  state.loads = (await query('SELECT * FROM dispatch_plan_load_assignments WHERE plan_id=336 ORDER BY load_id FOR UPDATE')).rows;
  state.assignments = (await query('SELECT * FROM dispatch_plan_order_assignments WHERE plan_id=336 ORDER BY order_ref')).rows;
  state.edges = (await query('SELECT * FROM dispatch_order_relation_edges WHERE plan_id=336 ORDER BY relation_type,owner_ref,member_ref')).rows;
  return state;
}

async function guard() {
  await query("SET LOCAL lock_timeout='5s'");
  await query("SET LOCAL statement_timeout='30s'");
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
  const leases = (await query("SELECT expires_at>now() AS active FROM dispatch_plan_edit_leases WHERE plan_date='2026-09-24' FOR UPDATE")).rows;
  assert.ok(leases.every(row => !row.active), 'Plan is being edited; retry when idle');
  await lockConsolidatedLoadOrders([...ids, 'GROUP:' + oldRef, 'GROUP:' + newRef]);
  for (const ref of [oldRef,newRef,parent,first,second,'SOB121097'].sort()) {
    for (const prefix of ['dispatch-global-source-refresh:','dispatch-global-order-definition:']) {
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [prefix + ref.toLowerCase()]);
    }
  }
}

async function assertIdle(state) {
  assert.equal(state.plan.planDate, '2026-09-24');
  assert.equal(state.plan.status, 'confirmed');
  assert.equal(state.headers.length, 4);
  assert.equal(state.headers.find(row => row.tranid === second).sales_order_type, 'Pick-Up');
  assert.ok(state.headers.every(row => row.operator_status === 'open' && row.fulfillment_status === 'not_fulfilled'));
  for (const row of state.lines) {
    for (const key of ['packed_sales_qty','packed_pallet_qty','packed_layer_qty','packed_section_qty','packed_piece_qty','loaded_qty']) {
      assert.equal(Number(row[key] || 0), 0, 'Packing or loading started');
    }
  }
  const load = state.loads.find(row => row.load_id === 'T8-L1790198961120-f10c1a378bc0d8');
  assert.ok(load && !load.started && !load.completed);
  const refs = [oldRef,newRef];
  for (const [table, column] of [
    ['operator_saved_delivery_orders','order_ref'],['operator_consolidation_orders','order_ref'],
    ['operator_load_records','order_ref'],['dispatch_order_completion_status','order_ref'],
    ['dispatch_operator_requests','order_ref'],['dispatch_so_po_allocations','dispatch_target_ref'],
    ['order_dependencies','dispatch_target_ref'],['local_co_orders','source_order_ref'],
    ['dispatch_order_catalog_refresh_outbox','order_ref']
  ]) {
    assert.equal((await query(`SELECT 1 FROM ${table} WHERE ${column}=ANY($1::text[]) LIMIT 1`, [refs])).rowCount, 0, `New reference in ${table}`);
  }
  assert.equal((await query("SELECT 1 FROM driver_job_records WHERE plan_id=336 AND load_id='T8-L1790198961120-f10c1a378bc0d8' LIMIT 1")).rowCount, 0);
  assert.equal((await query("SELECT 1 FROM operator_netsuite_posting_commands WHERE status IN ('pending','posting','finalizing') AND input_snapshot::text LIKE '%SOB120921%' LIMIT 1")).rowCount, 0);
}

async function persist(state, next) {
  const order = next.orders.find(row => row.id === newRef);
  const global = replaceRef(state.dispatch_global_order_groups.find(row => row.group_ref === oldRef).full_order);
  await query(`INSERT INTO dispatch_global_order_groups
    (group_ref,order_type,source_plan_id,source_plan_date,full_order,card,search_text,eligible,active,source_revision,created_at,updated_at)
    SELECT $2,order_type,source_plan_id,source_plan_date,$3::jsonb,$4::jsonb,$5,eligible,true,$6,created_at,now()
    FROM dispatch_global_order_groups WHERE group_ref=$1`,
    [oldRef,newRef,JSON.stringify(global),JSON.stringify(compactDispatchOrderCard(global)),dispatchOrderSearchText(global),next.revision]);
  await query(`INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position,created_at,hides_member)
    SELECT $2,member_order_ref,position,created_at,hides_member FROM dispatch_global_order_group_members WHERE group_ref=$1`, [oldRef,newRef]);
  await query(`INSERT INTO dispatch_delivery_groups(group_ref,plan_id,plan_date,order_type,truck_plate,load_name,parking_spot,active,created_at,updated_at)
    SELECT $2,plan_id,plan_date,order_type,truck_plate,load_name,parking_spot,true,created_at,now()
    FROM dispatch_delivery_groups WHERE group_ref=$1`, [oldRef,newRef]);
  await query(`INSERT INTO dispatch_delivery_group_members(group_ref,member_order_ref,position,created_at)
    SELECT $2,member_order_ref,position,created_at FROM dispatch_delivery_group_members WHERE group_ref=$1`, [oldRef,newRef]);
  await query('UPDATE dispatch_global_order_groups SET active=false,eligible=false,updated_at=now() WHERE group_ref=$1', [oldRef]);
  await query('UPDATE dispatch_delivery_groups SET active=false,updated_at=now() WHERE group_ref=$1', [oldRef]);
  const board = dispatchPlanBoard(state.plan);
  await query(`INSERT INTO dispatch_plan_snapshot_history
    (plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id,schema_version,plan_digest,order_count,truck_count,load_count,stop_count)
    VALUES(336,$1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,'split_group_suffix_rename','authorized-split-group-rename',2,$7,$8,$9,$10,$11)`,
    [state.plan.planDate,state.plan.revision,JSON.stringify(state.plan.orders),JSON.stringify(state.plan.trucks),JSON.stringify(state.plan.summary),
      state.plan.saved_at,digestDispatchPlan(state.plan),state.plan.orders.length,board.truckCount,board.loadCount,board.stopCount]);
  assert.equal((await query('UPDATE dispatch_plans SET revision=$1,updated_at=now() WHERE id=336 AND revision=$2', [next.revision,state.plan.revision])).rowCount, 1);
  await query('UPDATE dispatch_plan_snapshots SET orders=$1::jsonb,trucks=$2::jsonb,summary=$3::jsonb,plan_digest=$4,saved_at=now() WHERE plan_id=336',
    [JSON.stringify(next.orders),JSON.stringify(next.trucks),JSON.stringify(next.summary),digestDispatchPlan(next)]);
  await syncDispatchPlanOrderAssignments(next);
  await syncDispatchPlanRelationEdges(next);
  await query('DELETE FROM dispatch_order_catalog_entries WHERE order_ref=ANY($1::text[])', [[oldRef,newRef]]);
  await query('UPDATE dispatch_order_catalog_state SET generation=generation+1,catalog_count=(SELECT count(*) FROM dispatch_order_catalog_entries),updated_at=now() WHERE singleton=true');
  assert.equal(order.pallets, 23);
}

async function verify(before, next, requirePickupHidden) {
  const state = await readState();
  for (const key of ['headers','lines','splits','loads']) { assert.deepEqual(state[key], before[key], key + ' changed'); }
  for (const key of ['orders','trucks','summary']) { assert.deepEqual(state.plan[key], next[key]); }
  assert.equal(Number(state.plan.revision), Number(next.revision));
  const unrelated = rows => rows.filter(row => ![oldRef,newRef].includes(row.planned_order_ref))
    .map(({ updated_at: _updatedAt, ...row }) => row);
  assert.deepEqual(unrelated(state.assignments), unrelated(before.assignments), 'Unrelated assignments changed');
  for (const table of ['dispatch_global_order_groups','dispatch_delivery_groups']) {
    assert.equal(state[table].find(row => row.group_ref === oldRef).active, false);
    assert.equal(state[table].find(row => row.group_ref === newRef).active, true);
  }
  const catalog = await getDispatchOrderCatalogOrder(newRef);
  assert.equal(catalog.pallets, 23);
  assert.deepEqual(catalog.childOrders, [first,'SOB121097']);
  assert.equal(await getDispatchOrderCatalogOrder(oldRef), null);
  const delivery = await getDeliveryOrder('GROUP:' + newRef);
  assert.deepEqual(delivery.child_orders.map(row => row.tranid).sort(), [first,'SOB121097'].sort());
  assert.ok(state.assignments.some(row => row.order_ref === first && row.planned_order_ref === newRef));
  assert.ok(!state.assignments.some(row => row.order_ref === oldRef || row.planned_order_ref === oldRef));
  assert.ok(!state.edges.some(row => row.owner_ref === oldRef || row.member_ref === oldRef));
  const names = await auditNames();
  assert.deepEqual(names.missing, []);
  const pool = await listDispatchOrderPool({ type: 'SO', search: parent });
  assert.ok(pool.orders.some(row => row.id === newRef));
  const pickupHidden = !pool.orders.some(row => row.id === second);
  if (requirePickupHidden) { assert.ok(pickupHidden, 'Pickup visibility fix must be deployed first'); }
  return { groupRef: newRef, pallets: 23, pickupHidden, pickupMethod: 'Pick-Up', sourceAndRoutesPreserved: true, names };
}

async function main({ apply = false, expectedFingerprint = '', backupPath = '', requirePickupHidden = false } = {}) {
  return withTransaction(async () => {
    await guard();
    const state = await readState();
    await assertIdle(state);
    if (state.plan.orders.some(row => row.id === newRef)) {
      return { alreadyCorrect: true, applied: false, revision: state.plan.revision, checks: await verify(state,state.plan,requirePickupHidden) };
    }
    const names = await auditNames();
    assert.deepEqual(names.missing, [{ oldRef, newRef }]);
    assert.equal(state.dispatch_global_order_groups.length, 1, 'Target identity collision');
    assert.equal(state.dispatch_delivery_groups.length, 1, 'Target delivery identity collision');
    assert.equal(state.plan.orders.filter(row => row.id === oldRef).length, 1);
    const beforeFingerprint = fingerprint(state);
    if (apply) {
      assert.ok(requirePickupHidden, 'Pool fix must be required for commit');
      assert.equal(expectedFingerprint, beforeFingerprint, 'Incident changed; rehearse again');
      assert.ok(backupPath);
      await fs.writeFile(backupPath, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    }
    const next = { ...replaceRef(state.plan), revision: Number(state.plan.revision) + 1 };
    await persist(state,next);
    const checks = await verify(state,next,requirePickupHidden);
    const audit = await writeDispatchAudit({ action: 'dispatch.split_group_suffix_renamed', entityType: 'order', entityId: newRef,
      planId: 336, planDate: state.plan.planDate, source: 'authorized-split-group-rename', operatorName: 'system:authorized-repair',
      before: { groupRef: oldRef, revision: state.plan.revision }, after: { groupRef: newRef, revision: next.revision },
      details: { beforeFingerprint, checks, names } });
    return { applied: apply, rolledBack: !apply, beforeFingerprint, oldRevision: state.plan.revision,
      newRevision: next.revision, auditId: audit.id, checks };
  }, { rollback: !apply });
}

try { console.log(JSON.stringify(await main(JSON.parse(process.env.SPLIT_GROUP_RENAME_OPTIONS || '{}')))); }
finally { await closeDb(); }
