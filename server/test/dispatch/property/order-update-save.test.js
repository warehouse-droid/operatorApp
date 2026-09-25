import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import fc from 'fast-check';
import { query, withTransaction } from '../../../src/db.js';
import { enqueueDispatchPlanMaintenance, pendingDispatchPlanMaintenance, completeDispatchPlanMaintenance } from '../../../src/dispatch-plan-maintenance-queue.js';
import { applyPendingDispatchPlanMaintenance, processDispatchPlanMaintenance } from '../../../src/dispatch-plan-maintenance.js';
import { acquireDispatchPlanEditLease } from '../../../src/dispatch-plan-lease-repository.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { stored, seedMaintenanceIncident } from '../../support/order-update-save-fixture.mjs';

let fixture;
let incident;
before(async () => { fixture = await createDispatchV2Fixture(); incident = await seedMaintenanceIncident(fixture, { edit: false }); });
after(async () => { await fixture?.close(); });
const rollback = fn => withTransaction(fn, { rollback: true });

test('MAINT-PROP: lease ownership determines exactly whether maintenance may advance the plan', async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.integer({ min: 1, max: 12 }), async (editing, protectedStop, repeats) => rollback(async () => {
    const f = incident;
    if (protectedStop) {
      const trucks = structuredClone(f.baseline.trucks);
      trucks.push({ id: 'PROTECTED', loads: [{ id: 'property-load', stops: [{ id: 'property-drop', type: 'drop', orderId: f.obsolete[0] }] }] });
      await query('UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1', [f.id, JSON.stringify(trucks)]);
      await query(`INSERT INTO driver_job_records(job_id,driver_login,plan_id,load_id,stop_id,stop_type,order_refs,status,started_at,completed_at)
        VALUES('maintenance-property','property-driver',$1,'property-load','property-drop','dropoff',$2::jsonb,'complete',now(),now())`, [f.id, JSON.stringify([f.obsolete[0]])]);
    }
    const initial = await stored(f.id);
    if (editing) await acquireDispatchPlanEditLease({ planDate: f.plan_date, sessionId: 'property-editor', operatorId: fixture.operator.id });
    for (let i = 0; i < repeats; i++) await enqueueDispatchPlanMaintenance(f.id, { kind: 'sales_family', canonicalRef: f.canonicalRef, refs: f.obsolete });
    const result = await processDispatchPlanMaintenance(f.id);
    const final = await stored(f.id);
    const deferred = editing || protectedStop;
    assert.equal(result.changed, !deferred);
    assert.equal(final.revision, deferred ? 63 : 64);
    assert.equal(final.orders.some(order => f.obsolete.includes(order.id)), deferred);
    assert.deepEqual(final.trucks, initial.trucks);
    assert.equal(Boolean(await pendingDispatchPlanMaintenance(f.id)), deferred);
  })), { seed: 20260917, numRuns: 60 });
});

test('MAINT-PROP: coalescing and stale completion never drop the latest work', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async count => rollback(async () => {
    const f = incident;
    await enqueueDispatchPlanMaintenance(f.id, { kind: 'co_identity' });
    const first = await pendingDispatchPlanMaintenance(f.id);
    for (let i = 0; i < count; i++) await enqueueDispatchPlanMaintenance(f.id, { kind: 'co_identity', marker: i });
    await completeDispatchPlanMaintenance(first);
    const latest = await pendingDispatchPlanMaintenance(f.id);
    assert.ok(latest);
    assert.equal(Object.keys(latest.requests).length, 1);
    assert.equal(latest.requests['co_identity:'].marker, count - 1);
    assert.equal(Number(latest.generation), Number(first.generation) + count);
    await completeDispatchPlanMaintenance(latest);
    assert.equal(await pendingDispatchPlanMaintenance(f.id), null);
  })), { seed: 20260918, numRuns: 40 });
});

test('MAINT-PROP: a sequence of PO renames preserves cargo and resolves to its last identity', async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 1, max: 500 }), { minLength: 3, maxLength: 8 }), async ids => rollback(async () => {
    const f = incident;
    const refs = ids.map(id => `PO-PROP-${id}`);
    const order = { id: refs[0], type: 'PO', items: [{ itemId: 1784, quantity: 7 }], destinationAddress: '77 Preserved Road' };
    await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1', [f.id, JSON.stringify([order])]);
    for (let i = 1; i < refs.length; i++) await enqueueDispatchPlanMaintenance(f.id, { kind: 'po_reference', oldRef: refs[i - 1], newRef: refs[i] });
    assert.equal((await processDispatchPlanMaintenance(f.id)).changed, true);
    assert.deepEqual((await stored(f.id)).orders, [{ ...order, id: refs.at(-1) }]);
    assert.equal(await pendingDispatchPlanMaintenance(f.id), null);
  })), { seed: 20260919, numRuns: 60 });
});

test('MAINT-PROP: every buffered edit receives reference corrections until its lease ends', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 12 }), fc.integer({ min: 1, max: 500 }), async (moves, quantity) => rollback(async () => {
    const f = incident;
    await acquireDispatchPlanEditLease({ planDate: f.plan_date, sessionId: 'buffered-property', operatorId: fixture.operator.id });
    await enqueueDispatchPlanMaintenance(f.id, { kind: 'po_reference', oldRef: 'PO-BUFFER-OLD', newRef: 'PO-BUFFER-NEW' });
    const draft = { ...f.baseline, orders: [{ id: 'PO-BUFFER-OLD', type: 'PO', items: [{ itemId: 1784, quantity }] }] };
    for (let index = 0; index < moves; index++) {
      draft.trucks[0].parkingSpot = `MOVE-${index}`;
      const corrected = await applyPendingDispatchPlanMaintenance(structuredClone(draft));
      assert.equal(corrected.orders[0].id, 'PO-BUFFER-NEW');
      assert.equal(corrected.orders[0].items[0].quantity, quantity);
      assert.equal(corrected.trucks[0].parkingSpot, `MOVE-${index}`);
    }
    assert.equal((await pendingDispatchPlanMaintenance(f.id)).requests['po_reference:PO-BUFFER-OLD'].applied, true);
    await query('DELETE FROM dispatch_plan_edit_leases WHERE plan_date=$1', [f.plan_date]);
    await applyPendingDispatchPlanMaintenance(draft);
    assert.equal(await pendingDispatchPlanMaintenance(f.id), null);
  })), { seed: 20260920, numRuns: 30 });
});
