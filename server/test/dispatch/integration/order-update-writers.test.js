import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { query } from '../../../src/db.js';
import { deactivateUnplannedDispatchSplitOrders } from '../../../src/delivery-repository.js';
import { updateScmPurchaseOrderSplitRef, cancelScmPurchaseOrderSplit } from '../../../src/dispatch-repository.js';
import { repairDispatchCoGroupIdentities } from '../../../src/dispatch-co-group-identity-repository.js';
import { configureDispatchMaintenanceEvents, processDispatchPlanMaintenance } from '../../../src/dispatch-plan-maintenance.js';
import { createDispatchV2Fixture, dispatchOrder } from '../support/dispatch-v2-fixture.js';
import { stored, seedMaintenanceIncident } from '../../support/order-update-save-fixture.mjs';

let fixture;
const events = [];
before(async () => {
  fixture = await createDispatchV2Fixture();
  configureDispatchMaintenanceEvents((type, payload) => events.push({ type, payload }));
});
after(async () => { await fixture?.close(); });

test('MAINT-WRITER: split retirement keeps the edited snapshot stable and joins autosave', async () => {
  const f = await seedMaintenanceIncident(fixture);
  const result = await deactivateUnplannedDispatchSplitOrders({ originalOrderId: f.canonicalRef, orderType: 'SO', splitOrderIds: f.obsolete });
  assert.deepEqual(result.deactivated, f.obsolete);
  assert.deepEqual((await stored(f.id)).orders, f.baseline.orders, 'source retirement cannot rewrite the active draft baseline');
  const save = await f.save(f.baseline, 'retirement-save');
  assert.equal(save.response.status, 200, JSON.stringify(save.payload));
  assert.equal((await stored(f.id)).orders.some(order => f.obsolete.includes(order.id)), false);
});

test('MAINT-WRITER: CO identity repair defers while the date has an editor', async () => {
  const f = await seedMaintenanceIncident(fixture);
  const legacy = { id: 'GOA-CO-MAINT', type: 'CO', childOrders: ['CO-MAINT-A', 'CO-MAINT-B'],
    childOrderDetails: [{ id: 'CO-MAINT-A', type: 'CO' }, { id: 'CO-MAINT-B', type: 'CO' }], planOwned: true };
  await query('UPDATE dispatch_plan_snapshots SET orders=orders || $2::jsonb WHERE plan_id=$1', [f.id, JSON.stringify([legacy])]);
  const baseline = await stored(f.id);
  const result = await repairDispatchCoGroupIdentities({ planIds: [f.id] });
  assert.deepEqual(result.deferredPlanIds, [f.id]);
  assert.equal(result.repaired, 0);
  assert.deepEqual((await stored(f.id)).orders, baseline.orders);
  await query('DELETE FROM dispatch_plan_edit_leases WHERE plan_date=$1', [f.plan_date]);
  assert.equal((await processDispatchPlanMaintenance(f.id)).changed, true);
  assert.ok((await stored(f.id)).orders.some(order => order.id === 'CO-GOA-CO-MAINT'));
  assert.equal((await processDispatchPlanMaintenance(f.id)).changed, false);
});

test('MAINT-WRITER: PO reference rename is live in source but cannot invalidate the active save fence', async () => {
  const f = await seedMaintenanceIncident(fixture);
  const oldRef = 'PO-MAINT-S1';
  await query("INSERT INTO purchase_orders(netsuite_id,tranid) VALUES (9989001,'PO-MAINT'),(-9989001,$1)", [oldRef]);
  await query(`INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref)
    VALUES(9989001,'PO-MAINT',-9989001,$1)`, [oldRef]);
  const order = { ...dispatchOrder(oldRef, 0), type: 'PO' };
  await query('UPDATE dispatch_plan_snapshots SET orders=orders || $2::jsonb WHERE plan_id=$1', [f.id, JSON.stringify([order])]);
  const baseline = await stored(f.id);
  await updateScmPurchaseOrderSplitRef({ splitPoRef: oldRef, newPoRef: 'PO-MAINT-RENAMED' });
  assert.deepEqual((await stored(f.id)).orders, baseline.orders);
  assert.equal((await stored(f.id)).revision, baseline.revision);
  assert.equal((await query('SELECT split_po_ref FROM dispatch_scm_po_splits WHERE split_po_id=-9989001')).rows[0].split_po_ref, 'PO-MAINT-RENAMED');
  const saved = await f.save(baseline, 'po-rename-save');
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal((await stored(f.id)).orders.some(entry => entry.id === oldRef), false);
  const first = await stored(f.id);
  const buffered = { ...baseline, revision: first.revision, digest: first.digest };
  buffered.trucks[0].parkingSpot = 'BUFFERED-AFTER-RENAME';
  const second = await f.save(buffered, 'po-rename-buffered-save');
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  const final = await stored(f.id);
  assert.equal(final.trucks[0].parkingSpot, 'BUFFERED-AFTER-RENAME');
  assert.equal(final.orders.some(entry => entry.id === oldRef), false, 'a newer buffered move cannot revive the old PO identity');
  assert.ok(final.orders.some(entry => entry.id === 'PO-MAINT-RENAMED'));
  const current = await fixture.request(`/api/dispatch/plans/${f.id}`);
  const noChange = await f.save(current.payload, 'po-rename-no-change', true);
  assert.equal(noChange.response.status, 200, JSON.stringify(noChange.payload));
  assert.equal(noChange.payload.noChange, true);
  assert.equal((await stored(f.id)).revision, final.revision, 'retaining a correction must not turn unchanged saves into writes');
});

test('MAINT-WRITER: a buffered autosave cannot revive unbilled splits retired by unsplit', async () => {
  const f = await seedMaintenanceIncident(fixture);
  await query("UPDATE sales_orders SET status='B',status_text='Pending Fulfillment',netsuite_active=true WHERE tranid=ANY($1::text[])",
    [[f.canonicalRef, ...f.obsolete]]);
  await deactivateUnplannedDispatchSplitOrders({ originalOrderId: f.canonicalRef, orderType: 'SO', splitOrderIds: f.obsolete });
  const first = await f.save(f.baseline, 'unbilled-unsplit-save');
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  const acknowledged = await stored(f.id);
  const buffered = { ...f.baseline, revision: acknowledged.revision, digest: acknowledged.digest };
  buffered.trucks[0].parkingSpot = 'BUFFERED-AFTER-UNSPLIT';
  const saved = await f.save(buffered, 'unbilled-unsplit-buffered');
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  const final = await stored(f.id);
  assert.equal(final.trucks[0].parkingSpot, 'BUFFERED-AFTER-UNSPLIT');
  assert.equal(final.orders.some(order => f.obsolete.includes(order.id)), false);
});

test('MAINT-WRITER: successive source PO renames reach a snapshot still using the original reference', async () => {
  const f = await seedMaintenanceIncident(fixture);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid) VALUES (9989002,'PO-CHAIN'),(-9989002,'PO-CHAIN-Z')");
  await query(`INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref)
    VALUES(9989002,'PO-CHAIN',-9989002,'PO-CHAIN-Z')`);
  await query('UPDATE dispatch_plan_snapshots SET orders=orders || $2::jsonb WHERE plan_id=$1',
    [f.id, JSON.stringify([{ ...dispatchOrder('PO-CHAIN-Z', 0), type: 'PO' }])]);
  const baseline = await stored(f.id);
  await updateScmPurchaseOrderSplitRef({ splitPoRef: 'PO-CHAIN-Z', newPoRef: 'PO-CHAIN-A' });
  await updateScmPurchaseOrderSplitRef({ splitPoRef: 'PO-CHAIN-A', newPoRef: 'PO-CHAIN-B' });
  assert.deepEqual((await stored(f.id)).orders, baseline.orders);
  const saved = await f.save(baseline, 'po-chain-save');
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  const refs = (await stored(f.id)).orders.map(order => order.id);
  assert.ok(refs.includes('PO-CHAIN-B'), 'the final source identity must survive both deferred renames');
  assert.equal(refs.some(ref => ['PO-CHAIN-Z', 'PO-CHAIN-A'].includes(ref)), false);
});

test('MAINT-WRITER: unleased split retirement changes its fence once and announces the affected date', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  await deactivateUnplannedDispatchSplitOrders({ originalOrderId: f.canonicalRef, orderType: 'SO', splitOrderIds: f.obsolete });
  const final = await stored(f.id);
  assert.equal(final.revision, 64);
  assert.notEqual(final.digest, f.baseline.digest);
  assert.deepEqual(final.trucks, f.baseline.trucks);
  assert.equal(final.orders.some(order => f.obsolete.includes(order.id)), false);
  assert.equal(events.at(-1).payload.planDate, f.plan_date);
  assert.equal(events.at(-1).payload.revision, final.revision);
});

test('MAINT-WRITER: unleased CO repair updates its fence, projections and audit exactly once', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  const legacy = { id: 'GOA-CO-IMMEDIATE', type: 'CO', childOrders: ['CO-A', 'CO-B'],
    childOrderDetails: [{ id: 'CO-A', type: 'CO' }, { id: 'CO-B', type: 'CO' }], planOwned: true };
  await query('UPDATE dispatch_plan_snapshots SET orders=orders || $2::jsonb WHERE plan_id=$1', [f.id, JSON.stringify([legacy])]);
  const result = await repairDispatchCoGroupIdentities({ planIds: [f.id] });
  assert.deepEqual(result.planIds, [f.id]);
  assert.equal((await stored(f.id)).revision, 64);
  assert.ok((await stored(f.id)).orders.some(order => order.id === 'CO-GOA-CO-IMMEDIATE'));
  assert.deepEqual((await stored(f.id)).trucks, f.baseline.trucks);
  assert.equal(events.at(-1).payload.planDate, f.plan_date);
  assert.equal((await repairDispatchCoGroupIdentities({ planIds: [f.id] })).repaired, 0);
  assert.equal((await stored(f.id)).revision, 64);
});

test('MAINT-WRITER: unleased PO rename and cancellation notify only committed snapshots', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  await query("INSERT INTO purchase_orders(netsuite_id,tranid) VALUES (9989003,'PO-IMMEDIATE'),(-9989003,'PO-IMMEDIATE-S1')");
  await query(`INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref)
    VALUES(9989003,'PO-IMMEDIATE',-9989003,'PO-IMMEDIATE-S1')`);
  await query('UPDATE dispatch_plan_snapshots SET orders=orders || $2::jsonb WHERE plan_id=$1',
    [f.id, JSON.stringify([{ ...dispatchOrder('PO-IMMEDIATE-S1', 0), type: 'PO' }])]);
  await updateScmPurchaseOrderSplitRef({ splitPoRef: 'PO-IMMEDIATE-S1', newPoRef: 'PO-IMMEDIATE-RENAMED' });
  assert.equal((await stored(f.id)).revision, 64);
  assert.ok((await stored(f.id)).orders.some(order => order.id === 'PO-IMMEDIATE-RENAMED'));
  assert.equal(events.at(-1).payload.revision, 64);
  await cancelScmPurchaseOrderSplit({ splitPoRef: 'PO-IMMEDIATE-RENAMED' });
  const final = await stored(f.id);
  assert.equal(final.revision, 65);
  assert.equal(final.orders.some(order => order.id === 'PO-IMMEDIATE-RENAMED'), false);
  assert.deepEqual(final.trucks, f.baseline.trucks);
  assert.equal(events.at(-1).payload.planDate, f.plan_date);
  assert.equal(events.at(-1).payload.revision, 65);
});

test('MAINT-WRITER: CO repair defers a legacy type change that would alter Driver evidence', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  const group = { id: 'GOA-CO-PROTECTED', type: 'SO', childOrders: ['CO-PA', 'CO-PB'],
    childOrderDetails: [{ id: 'CO-PA', type: 'CO' }, { id: 'CO-PB', type: 'CO' }], planOwned: true };
  const trucks = structuredClone(f.baseline.trucks);
  trucks[0].loads[0].stops.push({ id: 'protected-co-drop', type: 'drop', orderId: group.id });
  await query('UPDATE dispatch_plan_snapshots SET orders=orders || $2::jsonb,trucks=$3::jsonb WHERE plan_id=$1',
    [f.id, JSON.stringify([group]), JSON.stringify(trucks)]);
  await query(`INSERT INTO driver_job_records(job_id,driver_login,plan_id,load_id,stop_id,stop_type,order_refs,status,started_at,completed_at)
    VALUES('maintenance-co-complete','driver-test',$1,'dp-v2-load-1','protected-co-drop','dropoff',$2::jsonb,'complete',now(),now())`, [f.id, JSON.stringify([group.id])]);
  const before = await stored(f.id);
  const result = await repairDispatchCoGroupIdentities({ planIds: [f.id] });
  assert.deepEqual(result.deferredPlanIds, [f.id]);
  assert.equal(result.repaired, 0);
  assert.deepEqual(await stored(f.id), before);
  assert.ok((await query('SELECT 1 FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0]);
});
