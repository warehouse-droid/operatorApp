import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { query, withTransaction, pool } from '../../../src/db.js';
import { configureDispatchMaintenanceEvents, drainDispatchPlanMaintenance, processDispatchPlanMaintenance } from '../../../src/dispatch-plan-maintenance.js';
import { enqueueDispatchPlanMaintenance, completeDispatchPlanMaintenance, pendingDispatchPlanMaintenance } from '../../../src/dispatch-plan-maintenance-queue.js';
import { acquireDispatchPlanEditLease } from '../../../src/dispatch-plan-lease-repository.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '../../../src/dispatch-fleet-status.js';
import { cleanupBilledSalesOrderFamiliesFromDispatchPlan } from '../../../src/dispatch-plan-repository.js';
import { dispatchMaintenanceTick } from '../../../src/server.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { stored, seedMaintenanceIncident } from '../../support/order-update-save-fixture.mjs';

let fixture;
const events = [];
before(async () => {
  fixture = await createDispatchV2Fixture();
  configureDispatchMaintenanceEvents((type, payload) => events.push({ type, payload }));
});
after(async () => { await fixture?.close(); });

test('MAINT-LIFE: expiry and worker restart drain current source state exactly once', async () => {
  const f = await seedMaintenanceIncident(fixture);
  await f.cleanup();
  assert.equal((await drainDispatchPlanMaintenance()).changed, 0);
  await query("UPDATE dispatch_plan_edit_leases SET expires_at=now()-interval '1 second' WHERE plan_date=$1", [f.plan_date]);
  const result = await drainDispatchPlanMaintenance();
  assert.equal(result.changed, 1);
  assert.equal((await stored(f.id)).revision, 64);
  assert.equal((await drainDispatchPlanMaintenance()).changed, 0);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0].n, 0);
});

test('MAINT-LIFE: Driver completion can persist cleanup intent before post-commit processing', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  await cleanupBilledSalesOrderFamiliesFromDispatchPlan({ planId: f.id, queueOnly: true });
  assert.equal((await stored(f.id)).revision, 63, 'recording intent must not run snapshot maintenance in the completion transaction');
  assert.ok((await query('SELECT 1 FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0]);
  assert.equal((await processDispatchPlanMaintenance(f.id)).changed, true);
  assert.equal((await stored(f.id)).revision, 64);
});

test('MAINT-LIFE: newer maintenance cannot be acknowledged by an older generation', async () => {
  const f = await seedMaintenanceIncident(fixture);
  await f.cleanup();
  await withTransaction(async () => {
    const old = await pendingDispatchPlanMaintenance(f.id);
    await enqueueDispatchPlanMaintenance(f.id, { kind: 'co_identity' });
    await completeDispatchPlanMaintenance(old);
    const remaining = await pendingDispatchPlanMaintenance(f.id);
    assert.ok(remaining);
    assert.equal(Number(remaining.generation), Number(old.generation) + 1);
    assert.equal(Object.keys(remaining.requests).length, 2);
  });
});

test('MAINT-LIFE: rolled-back cleanup retains snapshot, queue and emits no notification', async () => {
  const f = await seedMaintenanceIncident(fixture);
  await f.cleanup();
  await query('DELETE FROM dispatch_plan_edit_leases WHERE plan_date=$1', [f.plan_date]);
  const beforeEvents = events.length;
  await assert.rejects(withTransaction(async () => {
    assert.equal((await processDispatchPlanMaintenance(f.id)).changed, true);
    throw new Error('injected transaction failure');
  }), /injected transaction failure/);
  assert.equal((await stored(f.id)).revision, 63);
  assert.equal(events.length, beforeEvents);
  assert.ok((await query('SELECT 1 FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0]);
  assert.equal((await processDispatchPlanMaintenance(f.id)).changed, true);
  assert.equal(events.length, beforeEvents + 1);
  assert.equal(events.at(-1).payload.planDate, f.plan_date);
  assert.equal(events.at(-1).payload.revision, 64);
});

test('MAINT-LIFE: source reopening after queueing cancels obsolete billed intent', async () => {
  const f = await seedMaintenanceIncident(fixture);
  await f.cleanup();
  await query("UPDATE sales_orders SET status='B',status_text='Pending Fulfillment',netsuite_active=true WHERE tranid=ANY($1::text[])", [[f.canonicalRef, ...f.obsolete]]);
  await query('DELETE FROM dispatch_plan_edit_leases WHERE plan_date=$1', [f.plan_date]);
  const result = await processDispatchPlanMaintenance(f.id);
  assert.equal(result.changed, false);
  assert.equal(result.deferred, false);
  assert.deepEqual((await stored(f.id)).orders, f.baseline.orders);
  assert.equal((await stored(f.id)).revision, 63);
});

test('MAINT-LIFE: failed worker attempts retain work and expose bounded retry metadata', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  await enqueueDispatchPlanMaintenance(f.id, { kind: 'unknown-kind' });
  const result = await drainDispatchPlanMaintenance({ planDate: f.plan_date });
  assert.equal(result.failed, 1);
  const row = (await query('SELECT * FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0];
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /Unknown Dispatch maintenance/);
  assert.ok(new Date(row.available_at) > new Date(row.requested_at));
  assert.equal((await stored(f.id)).revision, 63);
});

test('MAINT-LIFE: worker waiting on fleet cannot write beneath a newly acquired editor', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  await enqueueDispatchPlanMaintenance(f.id, { kind: 'sales_family', canonicalRef: f.canonicalRef, refs: f.obsolete });
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
  const pending = processDispatchPlanMaintenance(f.id);
  try {
    await acquireDispatchPlanEditLease({ planDate: f.plan_date, operatorId: fixture.operator.id, sessionId: 'worker-race' });
  } finally { await blocker.query('COMMIT'); blocker.release(); }
  assert.equal((await pending).deferred, true);
  assert.equal((await stored(f.id)).revision, 63);
});

test('MAINT-LIFE: chained PO renames apply the latest reference regardless of JSON key order', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  await query(`UPDATE dispatch_plan_snapshots SET orders=orders || '[{"id":"PO-Z","type":"PO"}]'::jsonb WHERE plan_id=$1`, [f.id]);
  await enqueueDispatchPlanMaintenance(f.id, { kind: 'po_reference', oldRef: 'PO-Z', newRef: 'PO-A' });
  await enqueueDispatchPlanMaintenance(f.id, { kind: 'po_reference', oldRef: 'PO-A', newRef: 'PO-B' });
  assert.equal((await processDispatchPlanMaintenance(f.id)).changed, true);
  const orders = (await stored(f.id)).orders;
  assert.ok(orders.some(order => order.id === 'PO-B'));
  assert.equal(orders.some(order => ['PO-Z', 'PO-A'].includes(order.id)), false);
});

test('MAINT-LIFE: deferred PO retirement preserves the existing removal rules and summary', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  await query(`UPDATE dispatch_plan_snapshots SET orders=orders || '[{"id":"PO-REMOVE","type":"PO"}]'::jsonb WHERE plan_id=$1`, [f.id]);
  const previous = await stored(f.id);
  await enqueueDispatchPlanMaintenance(f.id, { kind: 'po_reference', oldRef: 'PO-REMOVE', remove: true });
  assert.equal((await processDispatchPlanMaintenance(f.id)).changed, true);
  const final = await stored(f.id);
  assert.deepEqual(final.summary, previous.summary);
  assert.deepEqual(final.trucks, previous.trucks);
  assert.deepEqual(final.orders, previous.orders.filter(order => order.id !== 'PO-REMOVE'));
});

test('MAINT-LIFE: Driver-protected cleanup stays queued while an unrelated valid edit saves', async () => {
  const f = await seedMaintenanceIncident(fixture);
  const draft = structuredClone(f.baseline);
  const protectedRef = f.obsolete[0];
  draft.trucks.push({ id: 'PROTECTED', plate: 'PROTECTED', loads: [{ id: 'protected-load',
    handoffTravelTo: '', handoffTravelFrom: '', handoffTravelMinutes: 0, plannedStartMinute: null, plannedFinishMinute: null, stops: [
    { id: 'protected-drop', type: 'drop', orderId: protectedRef, orderRefs: [protectedRef] }
  ] }] });
  await query('UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1', [f.id, JSON.stringify(draft.trucks)]);
  await query(`INSERT INTO driver_job_records(job_id,driver_login,plan_id,load_id,stop_id,stop_type,order_refs,status,started_at,completed_at)
    VALUES('maintenance-protected','driver-test',$1,'protected-load','protected-drop','dropoff',$2::jsonb,'complete',now(),now())`, [f.id, JSON.stringify([protectedRef])]);
  const baseline = await stored(f.id);
  await f.cleanup();
  baseline.trucks[0].startYard = '2967';
  const saved = await f.save(baseline, 'protected-maintenance-save');
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  const final = await stored(f.id);
  assert.deepEqual(final.trucks[1], draft.trucks[1]);
  assert.equal(final.trucks[0].startYard, '2967');
  assert.ok((await query('SELECT 1 FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0]);
});

test('MAINT-LIFE: unleased cleanup retains a Driver-completed stop and queues its protected work', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  const trucks = structuredClone(f.baseline.trucks);
  trucks[0].loads[0].stops.push({ id: 'completed-obsolete-drop', type: 'drop', orderId: f.obsolete[0] });
  await query('UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1', [f.id, JSON.stringify(trucks)]);
  await query(`INSERT INTO driver_job_records(job_id,driver_login,plan_id,load_id,stop_id,stop_type,order_refs,status,started_at,completed_at)
    VALUES('maintenance-unleased-complete','driver-test',$1,'dp-v2-load-1','completed-obsolete-drop','dropoff',$2::jsonb,'complete',now(),now())`, [f.id, JSON.stringify([f.obsolete[0]])]);
  const result = await f.cleanup();
  assert.equal(result.changedPlans.length, 0);
  assert.equal(result.deferred, true);
  assert.equal((await stored(f.id)).revision, 63);
  assert.deepEqual((await stored(f.id)).trucks, trucks);
  assert.ok(await pendingDispatchPlanMaintenance(f.id));
});

test('MAINT-LIFE: a failed queue sweep is reported and a later sweep can recover its work', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  await enqueueDispatchPlanMaintenance(f.id, { kind: 'sales_family', canonicalRef: f.canonicalRef, refs: f.obsolete });
  // A transient schema availability failure aborts this transaction. COMMIT
  // rolls it back, restoring both the table name and all its durable requests.
  await withTransaction(async () => {
    await query('ALTER TABLE dispatch_plan_maintenance RENAME TO temporarily_unavailable_maintenance');
    assert.deepEqual(await dispatchMaintenanceTick({ planDate: f.plan_date }), { failed: 1 });
  });
  assert.equal((await stored(f.id)).revision, 63);
  assert.ok(await pendingDispatchPlanMaintenance(f.id));
  assert.equal((await dispatchMaintenanceTick({ planDate: f.plan_date })).changed, 1);
  assert.equal((await stored(f.id)).revision, 64);
});
