import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after, before } from 'node:test';

import { config } from '../../../src/config.js';
import { query } from '../../../src/db.js';
import { createDispatchPlan, restoreDispatchPlanSnapshot } from '../../../src/dispatch-plan-repository.js';
import { createSpecialStockCase } from '../../../src/special-stock-request-repository.js';
import { buildDispatchPlanDelta } from '../../../src/dispatch-planner-optimization.js';
import { createDispatchV2Fixture, dispatchOrder } from '../support/dispatch-v2-fixture.js';

let fixture;
let originalCommandMode;
let nextDate = 0;
const truckPlate = 'SPECIAL-SAVE-TEST';
const driverLogin = 'special-save-test';
const dateBase = Date.UTC(2400 + crypto.randomInt(0, 100), 9, 1);

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  fixture = await createDispatchV2Fixture();
  originalCommandMode = config.dispatch.plannerCommandMode;
  config.dispatch.plannerCommandMode = 'on';
  await query("INSERT INTO dispatch_drivers(name,login,active) VALUES('Special Save Driver',$1,true)", [driverLogin]);
  await query('INSERT INTO dispatch_trucks(plate,active) VALUES($1,true)', [truckPlate]);
});

after(async () => {
  config.dispatch.plannerCommandMode = originalCommandMode;
  await fixture?.close();
});

async function candidate({ method, supplyStatus, family = 'SO' }) {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const soRef = `SO-SPECIAL-SAVE-${suffix}`;
  const poRef = `PO-SPECIAL-SAVE-${suffix}`;
  const dispatchRef = `SN-SPECIAL-SAVE-${suffix}`;
  const soId = 800_000_000 + Number.parseInt(suffix.slice(0, 6), 16);
  const poId = soId + 1;
  const special = await createSpecialStockCase({
    storeLocationId: 15,
    fulfillmentMethod: 'yard_pickup',
    inquiryDate: '2099-01-01',
    customerName: 'Special Save Customer',
    vendorName: 'Special Save Vendor',
    lines: [{ productName: 'Special Save Product', quantity: 1, uom: 'PLT', rate: 120, requiredDate: '2099-02-01' }]
  }, { operatorId: fixture.operator.id, authorizedStoreLocationIds: [15] });
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active,
    order_location_id,order_location,outbound_location_id,outbound_location,sales_order_type,delivery_method_id)
    VALUES($1,$2,'B','Pending Fulfillment',true,15,'12441',15,'12441','Delivery',2)`, [soId, soRef]);
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,status,status_text,netsuite_active,
    destination_location_id,destination_location,receipt_status)
    VALUES($1,$2,$3,'B','Pending Receipt',true,15,'12441','not_received')`, [poId, poRef, dispatchRef]);
  await query(`UPDATE sales_special_stock_cases SET fulfillment_method=$2,
    operational_yard_location_id=15,delivery_address='37 Sunmount Rd, Scarborough, ON',
    delivery_date='2099-02-01',delivery_window_start='09:00',delivery_window_end='12:00',
    delivery_instructions='Call before unloading',sales_order_netsuite_id=$3,sales_order_ref=$4,
    purchase_order_netsuite_id=$5,purchase_order_ref=$6 WHERE request_id=$1`,
  [special.id, method, soId, soRef, poId, poRef]);
  await query("UPDATE sales_special_stock_lines SET sales_decision='accepted',supply_status=$2 WHERE request_id=$1", [special.id, supplyStatus]);
  const planDate = new Date(dateBase + nextDate++ * 86_400_000).toISOString().slice(0, 10);
  const plan = await createDispatchPlan({ planDate });
  const lease = await fixture.acquireLease({ planDate, sessionId: `special-save-${suffix}` });
  const active = await fixture.request(`/api/dispatch/plans/${plan.id}`);
  assert.equal(active.response.status, 200);
  const orderRef = family === 'SO' ? soRef : dispatchRef;
  const order = { ...dispatchOrder(orderRef, 0), type: family, deliveryMethod: 'Delivery' };
  const trucks = [{ id: truckPlate, plate: truckPlate, driverLogin, loads: [{
    id: `special-save-load-${suffix}`, name: 'Load 1', driverLogin,
    stops: [
      ...(family === 'PO' ? [{ id: `special-pick-${suffix}`, type: 'pick', orderId: orderRef, location: 'Special Save Vendor Yard' }] : []),
      { id: `special-drop-${suffix}`, type: 'drop', orderId: orderRef, location: order.dropoffLocation }
    ]
  }] }];
  return { special, method, supplyStatus, poId, orderRef, plan: active.payload, lease,
    orders: [order], trucks, summary: { specialSaveTest: true } };
}

async function verifyApplied(state, response) {
  assert.equal(response.response.status, 200, JSON.stringify(response.payload));
  assert.notEqual(response.payload.applied, false);
  assert.equal(response.payload.recoveryDraft, undefined);
  assert.equal(response.payload.validationIssues, undefined);
  const plan = response.payload.plan || response.payload;
  assert.equal(plan.id, state.plan.id);
  assert.equal(plan.trucks[0].loads[0].stops.at(-1).orderId, state.orderRef);
  const active = await fixture.request(`/api/dispatch/plans/${state.plan.id}`);
  assert.equal(active.response.status, 200);
  assert.equal(active.payload.revision, plan.revision);
  assert.equal(active.payload.trucks[0].loads[0].stops.at(-1).orderId, state.orderRef);
  const recovery = await query("SELECT count(*)::int AS count FROM dispatch_plan_snapshot_history WHERE plan_id=$1 AND archive_reason='save_recovery'", [state.plan.id]);
  assert.equal(recovery.rows[0].count, 0);
  const special = (await query(`SELECT special.fulfillment_method,line.supply_status,purchase.receipt_status
    FROM sales_special_stock_cases special JOIN sales_special_stock_lines line ON line.request_id=special.request_id
    JOIN purchase_orders purchase ON purchase.netsuite_id=special.purchase_order_netsuite_id
    WHERE special.request_id=$1`, [state.special.id])).rows[0];
  assert.deepEqual(special, { fulfillment_method: state.method, supply_status: state.supplyStatus, receipt_status: 'not_received' });
}

const scenarios = ['vendor_pickup', 'yard_pickup', 'mbt_delivery'].flatMap(method =>
  ['in_stock', 'production', 'low_inventory'].flatMap(supplyStatus =>
    [false, true].map(forceSave => ({ method, supplyStatus, forceSave }))));
if (process.env.SPECIAL_PLANNING_SHUFFLE_SEED) {
  let seed = Number(process.env.SPECIAL_PLANNING_SHUFFLE_SEED);
  for (let index = scenarios.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const target = seed % (index + 1);
    [scenarios[index], scenarios[target]] = [scenarios[target], scenarios[index]];
  }
}
for (const { method, supplyStatus, forceSave } of scenarios) {
  test(`${forceSave ? 'Save Now' : 'autosave'} applies ${method} with ${supplyStatus} stock without a recovery draft`, async () => {
        const state = await candidate({ method, supplyStatus });
        const response = await fixture.request(`/api/dispatch/plans/${state.plan.id}`, {
          method: 'PUT',
          body: { ...state.plan, orders: state.orders, trucks: state.trucks, summary: state.summary,
            forceSave, baseRevision: state.plan.revision, baseDigest: state.plan.digest, editLeaseToken: state.lease,
            audit: { sessionId: fixture.leaseSession(state.lease), action: 'dispatch_plan_force_saved' } }
        });
        await verifyApplied(state, response);
  });
}

test('Save Now applies a vendor-pickup Special Item to a confirmed active plan', async () => {
  const state = await candidate({ method: 'vendor_pickup', supplyStatus: 'in_stock' });
  await query("UPDATE dispatch_plans SET status='confirmed',confirmed_at=now(),revision=revision+1 WHERE id=$1", [state.plan.id]);
  const confirmed = await fixture.request(`/api/dispatch/plans/${state.plan.id}`);
  assert.equal(confirmed.response.status, 200);
  state.plan = confirmed.payload;
  const response = await fixture.request(`/api/dispatch/plans/${state.plan.id}`, {
    method: 'PUT', body: { ...state.plan, orders: state.orders, trucks: state.trucks, summary: state.summary,
      forceSave: true, baseRevision: state.plan.revision, baseDigest: state.plan.digest, editLeaseToken: state.lease,
      audit: { sessionId: fixture.leaseSession(state.lease), action: 'dispatch_plan_force_saved' } }
  });
  await verifyApplied(state, response);
  assert.equal(response.payload.status, 'confirmed');
});

test('incremental Save applies a Special PO vendor pickup awaiting production', async () => {
  const state = await candidate({ method: 'vendor_pickup', supplyStatus: 'production', family: 'PO' });
  const next = { ...state.plan, orders: state.orders, trucks: state.trucks, summary: state.summary };
  const response = await fixture.request(`/api/dispatch/v2/plans/${state.plan.id}/commands`, {
    method: 'POST', headers: { 'x-dispatch-edit-lease': state.lease },
    body: { commandId: `special-save-${crypto.randomUUID()}`, commandType: 'update_load',
      baseRevision: state.plan.revision, baseDigest: state.plan.digest,
      sessionId: fixture.leaseSession(state.lease), payload: { planDelta: buildDispatchPlanDelta(state.plan, next) } }
  });
  await verifyApplied(state, response);
});

test('restore applies a saved Special Item vendor pickup awaiting production', async () => {
  const state = await candidate({ method: 'vendor_pickup', supplyStatus: 'production' });
  const snapshot = await query(`INSERT INTO dispatch_plan_snapshot_history(plan_id,plan_date,revision,orders,trucks,summary,archive_reason)
    VALUES($1,$2,$3,$4,$5,$6,'special_save_test') RETURNING id`,
  [state.plan.id, state.plan.planDate, state.plan.revision, JSON.stringify(state.orders), JSON.stringify(state.trucks), JSON.stringify(state.summary)]);
  const restored = await restoreDispatchPlanSnapshot(snapshot.rows[0].id, { sessionId: fixture.leaseSession(state.lease) });
  await verifyApplied(state, { response: { status: 200 }, payload: restored.plan });
});

const requestPlanningStates = [
  ['PO pending approval', {}, { status: 'A', statusText: 'Pending Approval' }],
  ['delivery applying', { fulfillment_change: { status: 'applying' } }],
  ['delivery attention', { fulfillment_change: { status: 'attention' } }],
  ['closure pending', { close_status: 'closure_pending' }],
  ['request closed', { close_status: 'closed' }],
  ['quantity pending', { quantity_review: { status: 'pending' } }],
  ['quantity applying', { quantity_review: { status: 'applying' } }],
  ['quantity attention', { quantity_review: { status: 'attention' } }],
  ['request attention', { attention: true, attention_reason: 'Sales Order has 1 unreviewed item line(s).' }],
  ['post-PO change', { post_po_change_pending: true }],
  ['combined request blockers', { attention: true, post_po_change_pending: true,
    close_status: 'closed', quantity_review: { status: 'attention' }, fulfillment_change: { status: 'applying' } },
  { status: 'A', statusText: 'Pending Approval' }]
];

async function planningFacts(state) {
  return (await query(`SELECT special.attention,special.attention_reason,special.post_po_change_pending,
    special.close_status,special.quantity_review,special.fulfillment_change,
    special.sales_order_operation_status,special.purchase_order_operation_status,
    purchase.status AS purchase_status,purchase.receipt_status
    FROM sales_special_stock_cases special JOIN purchase_orders purchase ON purchase.netsuite_id=special.purchase_order_netsuite_id
    WHERE special.request_id=$1`, [state.special.id])).rows[0];
}

async function requestState(state, fields, approval) {
  const allowed = new Set(['attention', 'attention_reason', 'post_po_change_pending', 'close_status', 'quantity_review', 'fulfillment_change']);
  const entries = Object.entries(fields);
  for (const [name] of entries) { assert.ok(allowed.has(name)); }
  if (entries.length) { await query(`UPDATE sales_special_stock_cases SET ${entries.map(([name], index) =>
    `${name}=$${index + 2}${['quantity_review', 'fulfillment_change'].includes(name) ? '::jsonb' : ''}`).join(',')} WHERE request_id=$1`,
  [state.special.id, ...entries.map(([, value]) => typeof value === 'object' ? JSON.stringify(value) : value)]); }
  if (approval) { await query('UPDATE purchase_orders SET status=$2,status_text=$3 WHERE netsuite_id=$1',
    [state.poId, approval.status, approval.statusText]); }
  return planningFacts(state);
}

async function saveCandidate(state, forceSave) {
  return fixture.request(`/api/dispatch/plans/${state.plan.id}`, { method: 'PUT',
    body: { ...state.plan, orders: state.orders, trucks: state.trucks, summary: state.summary,
      forceSave, baseRevision: state.plan.revision, baseDigest: state.plan.digest, editLeaseToken: state.lease,
      audit: { sessionId: fixture.leaseSession(state.lease), action: 'dispatch_plan_force_saved' } } });
}

for (const [label, fields, approval] of requestPlanningStates) {
  for (const forceSave of [false, true]) {
    test(`${forceSave ? 'Save Now' : 'autosave'} persists a Special SO with ${label} and preserves the request`, async () => {
      const state = await candidate({ method: 'mbt_delivery', supplyStatus: 'production' });
      const originalFacts = await requestState(state, fields, approval);
      await verifyApplied(state, await saveCandidate(state, forceSave));
      assert.deepEqual(await planningFacts(state), originalFacts);
    });
  }
}

for (const family of ['SO', 'PO']) {
  test(`incremental command persists ${family} despite every Special request blocker`, async () => {
    const state = await candidate({ method: 'vendor_pickup', supplyStatus: 'production', family });
    const [, fields, approval] = requestPlanningStates.at(-1);
    const originalFacts = await requestState(state, fields, approval);
    const next = { ...state.plan, orders: state.orders, trucks: state.trucks, summary: state.summary };
    const response = await fixture.request(`/api/dispatch/v2/plans/${state.plan.id}/commands`, {
      method: 'POST', headers: { 'x-dispatch-edit-lease': state.lease },
      body: { commandId: `special-unblocked-${crypto.randomUUID()}`, commandType: 'update_load',
        baseRevision: state.plan.revision, baseDigest: state.plan.digest,
        sessionId: fixture.leaseSession(state.lease), payload: { planDelta: buildDispatchPlanDelta(state.plan, next) } }
    });
    await verifyApplied(state, response);
    assert.deepEqual(await planningFacts(state), originalFacts);
  });
}

test('restore permits all Special request states without changing the request', async () => {
  const state = await candidate({ method: 'vendor_pickup', supplyStatus: 'production' });
  const [, fields, approval] = requestPlanningStates.at(-1);
  const originalFacts = await requestState(state, fields, approval);
  const snapshot = await query(`INSERT INTO dispatch_plan_snapshot_history(plan_id,plan_date,revision,orders,trucks,summary,archive_reason)
    VALUES($1,$2,$3,$4,$5,$6,'special_unblocked_test') RETURNING id`,
  [state.plan.id, state.plan.planDate, state.plan.revision, JSON.stringify(state.orders), JSON.stringify(state.trucks), JSON.stringify(state.summary)]);
  const restored = await restoreDispatchPlanSnapshot(snapshot.rows[0].id, { sessionId: fixture.leaseSession(state.lease) });
  assert.equal(restored.plan.trucks[0].loads[0].stops.at(-1).orderId, state.orderRef);
  assert.deepEqual(await planningFacts(state), originalFacts);
});

async function packingReview(state, operatorStatus = 'packed') {
  const id = (await query('SELECT sales_order_netsuite_id FROM sales_special_stock_cases WHERE request_id=$1', [state.special.id])).rows[0].sales_order_netsuite_id;
  await query('UPDATE sales_orders SET operator_status=$2 WHERE netsuite_id=$1', [id, operatorStatus]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,quantity,unit,pallet_qty,netsuite_active,synced_at)
    VALUES($1,1,2055,'MBBS-Special Order',1,'PC',1,true,now())`, [id]);
  await query(`INSERT INTO scm_reconciliation_order_state(order_kind,source_order_netsuite_id,source_order_ref,
    application_status,reconciliation_status,reconciliation_reason,proposed_state)
    VALUES('SO',$1,$2,'Reconcile Review','review',$3,$4::jsonb)`,
  [id, state.orderRef, `Unsubmitted Operator packing on ${state.orderRef}.`,
    JSON.stringify({ blockedByActiveDraft: true, calculatedApplicationStatus: 'Queued', draft: { orderRef: state.orderRef, operatorStatus } })]);
  return (await query('SELECT operator_status FROM sales_orders WHERE netsuite_id=$1', [id])).rows[0];
}

for (const operatorStatus of ['preparing', 'partial_packed', 'packed']) {
  for (const forceSave of [false, true]) {
    test(`${forceSave ? 'Save Now' : 'autosave'} permits ${operatorStatus} and packing-only Review`, async () => {
      const state = await candidate({ method: 'mbt_delivery', supplyStatus: 'in_stock' });
      const originalFacts = await packingReview(state, operatorStatus);
      await verifyApplied(state, await saveCandidate(state, forceSave));
      const stored = (await query('SELECT operator_status FROM sales_orders WHERE tranid=$1', [state.orderRef])).rows[0];
      assert.deepEqual(stored, originalFacts);
      const review = (await query('SELECT reconciliation_status FROM scm_reconciliation_order_state WHERE source_order_ref=$1', [state.orderRef])).rows[0];
      assert.equal(review.reconciliation_status, 'review');
      const { loadDispatchOrdersForResponse } = await import('../../../src/server.js');
      const [order] = (await loadDispatchOrdersForResponse({ type: 'SO', exactOrderRefs: [state.orderRef] })).filter(candidateOrder => candidateOrder.id === state.orderRef);
      assert.ok(order); assert.equal(order.dispatchPlanningRestricted, false);
      assert.equal(order.operatorStatus, operatorStatus);
    });
  }
}

test('grouped sales deliveries with preparing and packed members remain planable', async () => {
  const first = await candidate({ method: 'mbt_delivery', supplyStatus: 'in_stock' });
  const second = await candidate({ method: 'mbt_delivery', supplyStatus: 'in_stock' });
  await packingReview(first, 'preparing'); await packingReview(second, 'packed');
  const groupRef = `GOB-PACKING-${crypto.randomUUID().slice(0, 8)}`;
  const group = { ...first.orders[0], id: groupRef, childOrders: [first.orderRef, second.orderRef],
    childOrderDetails: [...first.orders, ...second.orders], items: [...first.orders[0].items, ...second.orders[0].items] };
  first.orders = [group]; first.orderRef = groupRef;
  first.trucks[0].loads[0].stops.at(-1).orderId = groupRef;
  const response = await saveCandidate(first, true);
  await verifyApplied(first, response);
  const saved = response.payload.orders.find(order => order.id === groupRef);
  assert.ok(saved); assert.equal(saved.dispatchPlanningRestricted, false); assert.equal(saved.reconciliationBlocked, false);
  assert.notEqual(saved.reconciliationStatus, 'review');
});
