import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {query, pool, withTransaction, closeDb} from '../../../src/db.js';
import {decorateSorOrders, reconcileSorReturnDrafts, sorReturnActivity} from '../../../src/sor-rental-repository.js';
import {sorReturnDraft} from '../../../src/sor-rental-policy.js';
import {sorSourceDrafts, runSorReturnQueue} from '../../../src/sor-rental-service.js';
import {getDispatchCustomOrder, dispatchOrderFromCustomOrder, canonicalizeDispatchCustomOrdersInPlan} from '../../../src/dispatch-custom-order-repository.js';
import {syncDispatchPlanOrderAssignments, syncDispatchPlanLoadProjection} from '../../../src/dispatch-planner-v2-repository.js';
import {syncDispatchDeliveryGroupsFromPlan} from '../../../src/dispatch-delivery-group-repository.js';
import {getDispatchOrderCatalogOrder} from '../../../src/dispatch-order-catalog-repository.js';
import {getDriverPlanRoutesForDate} from '../../../src/driver-repository.js';
import {getSorReturnReadiness} from '../../../src/sor-return-readiness.js';
import {persistedDispatchPlan} from '../../../src/dispatch-plan-fence.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from '../../../src/dispatch-fleet-status.js';

after(closeDb);
const sourceRef = 'SOR99000248';
const returnRef = `${sourceRef}-Return`;
const sourceId = 99000248;

async function savedReturn() {
  return (await query('SELECT * FROM dispatch_custom_orders WHERE ref_number=$1', [returnRef])).rows[0];
}
async function savedPlan(id) {
  return persistedDispatchPlan((await query(`SELECT p.*,s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p
    JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [id])).rows[0]);
}
async function fixture({assigned = true} = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='sor_rental_workflow'");
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,sales_order_type,netsuite_active,status_text)
    VALUES($1,$2,'Delivery',true,'Pending Billing')`, [sourceId, sourceRef]);
  const [source] = await decorateSorOrders([{id: sourceRef, type: 'SO', netsuiteId: sourceId, address: '77 Original Site',
    customer: 'Synthetic rental customer', items: [{lineId: 1, lineRowId: 1, itemId: 99010756, itemName: 'Lift 9.8m/Day',
      itemType: 'Service', description: 'Original lift', quantity: 1, lineWeight: 100, unit: null}]}]);
  const draft = sorReturnDraft(source);
  await reconcileSorReturnDrafts(sourceRef, [draft]);
  const custom = await getDispatchCustomOrder((await savedReturn()).id);
  const order = dispatchOrderFromCustomOrder(custom);
  const planRow = (await query(`INSERT INTO dispatch_plans(plan_date,status,revision,confirmed_at)
    VALUES('2097-10-23','confirmed',1,now()) RETURNING *`)).rows[0];
  const trucks = assigned ? [{id: 'sor-refresh-truck', plate: 'SOR-REFRESH', driverLogin: 'sor-refresh-driver', base: '3445',
    loads: [{id: 'sor-refresh-load', name: 'Rental collection', driverLogin: 'sor-refresh-driver',
      stops: [{id: 'sor-refresh-pick', orderId: returnRef, type: 'pick', location: draft.pickupLocation},
        {id: 'sor-refresh-drop', orderId: returnRef, type: 'drop', location: draft.dropoffLocation}]}]}] : [];
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,'{}')",
    [planRow.id, JSON.stringify([order]), JSON.stringify(trucks)]);
  const plan = await savedPlan(planRow.id);
  await syncDispatchPlanOrderAssignments(plan);
  await syncDispatchPlanLoadProjection(plan);
  await syncDispatchDeliveryGroupsFromPlan(plan);
  return {source, draft, plan, order};
}
function changedDraft(draft) {
  return {...draft, salesQty: 2, weightLbs: 160, lineSnapshot: [{...draft.lineSnapshot[0], itemId: 99010750,
    itemName: 'Lift 7.8m/Day', description: 'Replacement lift', quantity: 2, lineWeight: 160}]};
}

test('assigned untouched return refreshes equipment, quantity, plan, derived catalog and driver cargo without unassigning', async () => withTransaction(async () => {
  const f = await fixture();
  const assignment = (await query('SELECT plan_id,load_id,stop_id,order_ref FROM dispatch_plan_order_assignments WHERE order_ref=$1', [returnRef])).rows;
  assert.equal(await sorReturnActivity(returnRef), true, 'existing activity API still reports assigned work');
  await query("UPDATE dispatch_custom_orders SET sor_review_reason='Source items changed' WHERE ref_number=$1", [returnRef]);
  const result = await reconcileSorReturnDrafts(sourceRef, [changedDraft(f.draft)]);
  assert.equal(result.updated, 1);
  assert.equal(result.review, 0);
  assert.equal(await sorReturnActivity(returnRef), true, 'automatic refresh preserves the assignment');
  const saved = await savedReturn();
  assert.equal(saved.line_snapshot[0].itemId, 99010750);
  assert.equal(Number(saved.sales_qty), 2);
  assert.equal(saved.sor_review_reason, '');
  const plan = await savedPlan(f.plan.id);
  assert.equal(plan.orders[0].items[0].itemId, 99010750);
  assert.equal(plan.orders[0].items[0].quantity, 2);
  assert.equal(plan.revision, f.plan.revision + 1);
  assert.deepEqual(plan.trucks.map(t => t.loads.map(l => l.stops.map(s => s.id))), f.plan.trucks.map(t => t.loads.map(l => l.stops.map(s => s.id))));
  assert.deepEqual((await query('SELECT plan_id,load_id,stop_id,order_ref FROM dispatch_plan_order_assignments WHERE order_ref=$1', [returnRef])).rows, assignment);
  assert.equal((await getDispatchOrderCatalogOrder(returnRef)).items[0].itemId, 99010750);
  const routes = await getDriverPlanRoutesForDate(f.plan.planDate);
  assert.match(JSON.stringify(routes), /Lift 7\.8m\/Day/);
  assert.doesNotMatch(JSON.stringify(routes), /Lift 9\.8m\/Day/);
  assert.equal((await getSorReturnReadiness([returnRef]))[0].allowed, true);
  const staleSave = await canonicalizeDispatchCustomOrdersInPlan(f.plan, {previousPlan: plan});
  assert.equal(staleSave.orders[0].items[0].itemId, 99010750, 'stale editor cannot restore old cargo');
}, {rollback: true}));

test('assigned untouched source address refreshes its pickup and invalidates old route timing', async () => withTransaction(async () => {
  const f = await fixture();
  const result = await reconcileSorReturnDrafts(sourceRef, [{...f.draft, pickupLocation: '88 New Site'}]);
  assert.equal(result.updated, 1);
  assert.equal((await savedReturn()).pickup_location, '88 New Site');
  const plan = await savedPlan(f.plan.id);
  assert.equal(plan.orders[0].sourceAddress, '88 New Site');
  assert.equal(plan.trucks[0].loads[0].stops[0].location, '88 New Site');
  assert.equal(plan.trucks[0].loads[0].stops[0].id, 'sor-refresh-pick');
  assert.equal(plan.trucks[0].loads[0].routeProjectionRefreshRequired, true);
}, {rollback: true}));

test('unassigned return refreshes an existing derived catalog definition', async () => withTransaction(async () => {
  const f = await fixture({assigned: false});
  assert.equal((await reconcileSorReturnDrafts(sourceRef, [changedDraft(f.draft)])).updated, 1);
  assert.equal((await getDispatchOrderCatalogOrder(returnRef)).items[0].itemId, 99010750);
}, {rollback: true}));

test('JSON key ordering and null/empty unit round trips cannot mark assigned unchanged work for review', async () => withTransaction(async () => {
  const f = await fixture();
  await fc.assert(fc.asyncProperty(fc.integer({min: 0, max: 1000}), async seed => {
    const reorder = value => {
      if (Array.isArray(value)) {return value.map(reorder);}
      if (!value || typeof value !== 'object') {return value;}
      const keys = Object.keys(value);
      const offset = seed % (keys.length || 1);
      return Object.fromEntries([...keys.slice(offset), ...keys.slice(0, offset)].reverse().map(key => [key, reorder(value[key])]));
    };
    const copy = reorder(f.draft);
    copy.parentSalesOrderId = String(copy.parentSalesOrderId);
    copy.lineSnapshot[0].unit = seed % 2 ? '' : null;
    const result = await reconcileSorReturnDrafts(sourceRef, [copy]);
    assert.equal(result.review, 0);
    assert.equal(result.updated, 0);
    assert.equal((await savedReturn()).sor_review_reason, '');
    assert.equal((await savedPlan(f.plan.id)).revision, f.plan.revision);
  }), {numRuns: 20, seed: 248});
}, {rollback: true}));

test('obsolete review clears for unchanged assigned work', async () => withTransaction(async () => {
  const f = await fixture();
  await query("UPDATE dispatch_custom_orders SET sor_review_reason='Old source change' WHERE ref_number=$1", [returnRef]);
  await reconcileSorReturnDrafts(sourceRef, [f.draft]);
  assert.equal((await savedReturn()).sor_review_reason, '');
  assert.equal((await getSorReturnReadiness([returnRef]))[0].allowed, true);
}, {rollback: true}));

test('source edits refresh an existing return after delivery, without backfilling a historical order', async () => withTransaction(async () => {
  const f = await fixture();
  await query(`INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status)
    VALUES('sor-refresh-delivered','sor-refresh-driver','dropoff',$1::jsonb,'complete')`, [JSON.stringify([sourceRef])]);
  await query("UPDATE sales_orders SET status_text='Billed' WHERE netsuite_id=$1", [sourceId]);
  const source = {...f.source, items: changedDraft(f.draft).lineSnapshot};
  const existing = await sorSourceDrafts(sourceRef, [source]);
  assert.equal(existing.drafts.length, 1);
  assert.equal(existing.drafts[0].lineSnapshot[0].itemId, 99010750);
  await query('DELETE FROM dispatch_custom_orders WHERE ref_number=$1', [returnRef]);
  assert.equal((await sorSourceDrafts(sourceRef, [source])).drafts.length, 0);
}, {rollback: true}));

test('projection failure rolls the source refresh back atomically', async () => withTransaction(async () => {
  const f = await fixture();
  const before = await savedReturn();
  await query(`CREATE FUNCTION pg_temp.fail_sor_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic projection failure'; END $$`);
  await query(`CREATE TRIGGER sor_refresh_failure BEFORE UPDATE ON dispatch_plan_snapshots
    FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_sor_refresh()`);
  await assert.rejects(reconcileSorReturnDrafts(sourceRef, [changedDraft(f.draft)]), /synthetic projection failure/);
  assert.deepEqual(await savedReturn(), before);
  assert.equal((await savedPlan(f.plan.id)).revision, f.plan.revision);
}, {rollback: true}));

test('started pickup retains recorded equipment and receives a specific review reason', async () => withTransaction(async () => {
  const f = await fixture();
  await query(`INSERT INTO driver_job_records(job_id,driver_login,plan_id,load_id,stop_id,stop_type,order_refs,status,started_at)
    VALUES('sor-refresh-started','sor-refresh-driver',$1,'sor-refresh-load','sor-refresh-pick','pickup',$2::jsonb,'in_progress',now())`,
  [f.plan.id, JSON.stringify([returnRef])]);
  const result = await reconcileSorReturnDrafts(sourceRef, [changedDraft(f.draft)]);
  assert.equal(result.review, 1);
  assert.equal((await savedReturn()).line_snapshot[0].itemId, 99010756);
  assert.match((await savedReturn()).sor_review_reason, /started|execution/i);
  assert.deepEqual((await savedPlan(f.plan.id)).orders, f.plan.orders);
}, {rollback: true}));

test('completed collection and an assigned collection removed from source retain their safeguards', async () => withTransaction(async () => {
  const f = await fixture();
  assert.equal((await reconcileSorReturnDrafts(sourceRef, [])).review, 1);
  assert.equal((await savedReturn()).status, 'open');
  await query("UPDATE dispatch_custom_orders SET status='completed' WHERE ref_number=$1", [returnRef]);
  const before = await savedReturn();
  assert.equal((await reconcileSorReturnDrafts(sourceRef, [changedDraft(f.draft)])).updated, 0);
  assert.deepEqual(await savedReturn(), before);
}, {rollback: true}));

for (const changeAddress of [false, true]) {
  test(`completed travel preserves its destination while ${changeAddress ? 'holding a changed address for review' : 'refreshing uncollected equipment'}`, async () => withTransaction(async () => {
    const f = await fixture();
    await query(`INSERT INTO driver_job_records(job_id,driver_login,plan_id,load_id,stop_type,order_refs,status,started_at,completed_at,job_details)
      VALUES('sor-refresh-travel','sor-refresh-driver',$1,'sor-refresh-load','travel','[]','complete',now(),now(),$2::jsonb)`,
    [f.plan.id, JSON.stringify({fromLocation: '3445', toLocation: f.draft.pickupLocation, toStopId: 'sor-refresh-pick'})]);
    const before = (await query("SELECT * FROM driver_job_records WHERE job_id='sor-refresh-travel'")).rows[0];
    const draft = changeAddress ? {...f.draft, pickupLocation: '99 Different Destination'} : changedDraft(f.draft);
    const result = await reconcileSorReturnDrafts(sourceRef, [draft]);
    assert.equal(result.review, changeAddress ? 1 : 0);
    assert.equal(result.updated, changeAddress ? 0 : 1);
    assert.equal((await savedReturn()).pickup_location, f.draft.pickupLocation);
    assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE job_id='sor-refresh-travel'")).rows[0], before);
    if (changeAddress) {assert.deepEqual((await savedPlan(f.plan.id)).trucks, f.plan.trucks);}
  }, {rollback: true}));
}

test('a driver start holding the fleet lock commits before a concurrent refresh can change cargo', async () => {
  const f = await fixture();
  const client = await pool.connect();
  let pending;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
    await client.query(`INSERT INTO driver_job_records(job_id,driver_login,plan_id,load_id,stop_id,stop_type,order_refs,status,started_at)
      VALUES('sor-refresh-racing-start','sor-refresh-driver',$1,'sor-refresh-load','sor-refresh-pick','pickup',$2::jsonb,'in_progress',now())`,
    [f.plan.id, JSON.stringify([returnRef])]);
    let finished = false;
    pending = reconcileSorReturnDrafts(sourceRef, [changedDraft(f.draft)]).then(value => {finished = true; return value;});
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(finished, false, 'refresh must wait for the driver transaction');
    await client.query('COMMIT');
    const result = await pending;
    assert.equal(result.review, 1);
    assert.equal((await savedReturn()).line_snapshot[0].itemId, 99010756);
    assert.deepEqual((await savedPlan(f.plan.id)).orders, f.plan.orders);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pending?.catch(() => {});
    await query("DELETE FROM driver_job_records WHERE job_id='sor-refresh-racing-start'");
    await query('DELETE FROM dispatch_plans WHERE id=$1', [f.plan.id]);
    await query('DELETE FROM dispatch_global_order_splits WHERE split_ref=$1', [returnRef]);
    await query('DELETE FROM dispatch_custom_orders WHERE ref_number=$1', [returnRef]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=$1', [sourceId]);
    await query('DELETE FROM sor_return_reconcile_queue WHERE source_ref=$1', [sourceRef]);
    await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='sor_rental_workflow'");
  }
});

test('retired source lines cannot reappear in the return of a fulfilled order', async () => withTransaction(async () => {
  const f = await fixture();
  const lines = [];
  for (const [index, active] of [false, true].entries()) {
    const item = active ? changedDraft(f.draft).lineSnapshot[0] : f.draft.lineSnapshot[0];
    const row = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,netsuite_active)
      VALUES($1,$2,$3,$4,'Service',1,$5) RETURNING id`, [sourceId, index + 1, item.itemId, item.itemName, active])).rows[0];
    lines.push({...item, lineRowId: Number(row.id)});
  }
  const selected = await sorSourceDrafts(sourceRef, [{...f.source, items: lines}]);
  assert.deepEqual(selected.drafts[0].lineSnapshot.map(line => line.itemId), [99010750]);
}, {rollback: true}));

test('a source that explicitly removes all equipment cannot resurrect the saved delivered-equipment snapshot', async () => {
  const f = await fixture();
  try {
    await query('DELETE FROM sor_return_reconcile_queue');
    await query("UPDATE sales_orders SET status_text='Billed' WHERE netsuite_id=$1", [sourceId]);
    await query(`INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status)
      VALUES('sor-refresh-delivered-empty','sor-refresh-driver','dropoff',$1::jsonb,'complete')`, [JSON.stringify([sourceRef])]);
    await runSorReturnQueue({loadOrders: async () => [{...f.source, items: []}], limit: 1});
    const saved = await savedReturn();
    assert.equal(saved.status, 'open');
    assert.match(saved.sor_review_reason, /no longer requires/i);
    assert.equal((await query('SELECT 1 FROM dispatch_plan_order_assignments WHERE order_ref=$1', [returnRef])).rowCount, 1);
  } finally {
    await query("DELETE FROM driver_job_records WHERE job_id='sor-refresh-delivered-empty'");
    await query('DELETE FROM dispatch_plans WHERE id=$1', [f.plan.id]);
    await query('DELETE FROM dispatch_global_order_splits WHERE split_ref=$1', [returnRef]);
    await query('DELETE FROM dispatch_custom_orders WHERE ref_number=$1', [returnRef]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=$1', [sourceId]);
    await query('DELETE FROM sor_return_reconcile_queue WHERE source_ref=$1', [sourceRef]);
    await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='sor_rental_workflow'");
  }
});
