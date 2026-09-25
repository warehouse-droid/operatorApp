import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { query } from '../../../src/db.js';
import { createDispatchV2Fixture } from '../../dispatch/support/dispatch-v2-fixture.js';
import { seedLinkGroup } from '../../support/link-to-fix-fixture.mjs';
import { stored } from '../../support/order-update-save-fixture.mjs';
import { dispatchRequiredPickupVisitLocations } from '../../../src/dispatch-pickup-visits.js';
import { dispatchV2FollowupTick } from '../../../src/server.js';

let http;
before(async () => {
  http = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks(plate,active) VALUES('LINK-GROUP-HTTP',true)");
});
after(async () => { await http?.close(); });

async function prepare({ normal = false, savedSources = true } = {}) {
  const f = await seedLinkGroup();
  await query('DELETE FROM local_co_orders WHERE co_ref=$1', [f.coRef]);
  await query("UPDATE sales_orders SET dispatch_address='100 Customer Road' WHERE tranid=ANY($1)", [f.members]);
  f.group = { ...f.group, sourceYard: '150', pickupLocations: ['150'], address: '100 Customer Road',
    childOrderDetails: f.group.childOrderDetails.map(child => ({ ...child, sourceYard: '150', pickupLocations: ['150'], address: '100 Customer Road' })) };
  if (normal) {
    await query('DELETE FROM dispatch_global_order_groups WHERE group_ref=$1', [f.groupRef]);
  } else {
    await query('UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1', [f.groupRef, JSON.stringify(f.group)]);
  }
  const orders = normal ? (savedSources ? f.group.childOrderDetails : []) : [f.group];
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks='[]'::jsonb WHERE plan_id=$1", [f.plan.id, JSON.stringify(orders)]);
  f.sessionId = `link-group-${crypto.randomUUID()}`;
  f.token = await http.acquireLease({ planDate: f.plan.planDate, sessionId: f.sessionId });
  const target = normal ? f.members[0] : f.groupRef;
  const options = await http.request(`/api/dispatch/order-dependencies/options?${new URLSearchParams({
    dispatchTargetRef: target, planDate: f.plan.planDate, transferOrderRef: f.transferRef.toLowerCase()
  })}`);
  assert.equal(options.response.status, 200, JSON.stringify(options.payload));
  assert.equal(options.payload.matchError, '');
  const linked = await http.request('/api/dispatch/order-dependencies?response=targeted', {
    method: 'POST', headers: { 'x-dispatch-edit-lease': f.token }, body: {
      dispatchTargetRef: target, planDate: f.plan.planDate, transferOrderRef: f.transferRef.toLowerCase(),
      mode: 'direct_to_customer', requestId: crypto.randomUUID(), targetSignature: options.payload.targetSignature,
      allocations: options.payload.matchingLines.map(line => ({ targetLineKey: line.targetLineKey, quantities: line.suggestedQuantities })),
      audit: { sessionId: f.sessionId }
    }
  });
  assert.equal(linked.response.status, 201, JSON.stringify(linked.payload));
  f.dependencyId = linked.payload.dependency.id;
  return f;
}

async function save(f, draft, classic) {
  const baseline = await stored(f.plan.id);
  return http.request(classic ? `/api/dispatch/plans/${f.plan.id}` : `/api/dispatch/v2/plans/${f.plan.id}/commands`, {
    method: classic ? 'PUT' : 'POST', headers: { 'x-dispatch-edit-lease': f.token },
    body: classic ? { ...baseline, ...draft, planId: f.plan.id, editLeaseToken: f.token, commandId: crypto.randomUUID(),
      baseRevision: baseline.revision, baseDigest: baseline.digest, audit: { sessionId: f.sessionId } }
      : { commandId: crypto.randomUUID(), baseRevision: baseline.revision, baseDigest: baseline.digest,
        sessionId: f.sessionId, commandType: 'replace_plan', payload: { planDate: f.plan.planDate, ...draft } }
  });
}

for (const classic of [false, true]) {
  test(`group first, then lowercase TO link, reload, plan and ${classic ? 'classic' : 'V2'} save retains remote pickup`, async () => {
    const f = await prepare();
    const loaded = await http.request(`/api/dispatch/plans/${f.plan.id}`);
    assert.equal(loaded.response.status, 200, JSON.stringify(loaded.payload));
    const group = loaded.payload.orders.find(order => order.id === f.groupRef);
    assert.ok(group);
    const locations = dispatchRequiredPickupVisitLocations(group);
    assert.ok(locations.includes('2967'), JSON.stringify(group.pickupLocations));
    const stops = locations.map((location, index) => ({ id: `PICK-${index}`, type: 'pick', orderId: group.id, orderRefs: [group.id], location }));
    stops.push({ id: 'DROP', type: 'drop', orderId: group.id, location: group.address });
    const saved = await save(f, { orders: [group], trucks: [{ id: 'LINK-GROUP-HTTP', plate: 'LINK-GROUP-HTTP',
      loads: [{ id: `LINK-${f.plan.id}`, name: 'Load 1', stops }] }], summary: {} }, classic);
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    assert.equal((await dispatchV2FollowupTick()).failed, 0);
    const persisted = await stored(f.plan.id);
    assert.ok(persisted.trucks[0].loads[0].stops.some(stop => stop.type === 'pick' && stop.location === '2967'));
    assert.equal((await query('SELECT planned_plan_id FROM order_dependencies WHERE id=$1', [f.dependencyId])).rows[0].planned_plan_id, String(f.plan.id));
  });
}

for (const savedSources of [true, false]) {
  test(`link first, then group and save ${savedSources ? 'saved' : 'unplanned pool'} SOs retargets the dependency`, async () => {
    const f = await prepare({ normal: true, savedSources });
    const saved = await save(f, { orders: [f.group], trucks: [], summary: {} }, false);
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    assert.equal((await dispatchV2FollowupTick()).failed, 0);
    const dependency = (await query('SELECT dispatch_target_ref,dispatch_target_kind FROM order_dependencies WHERE id=$1', [f.dependencyId])).rows[0];
    assert.equal(dependency.dispatch_target_ref, f.groupRef);
    assert.equal(dependency.dispatch_target_kind, 'group');
  });
}

test('a direct link with execution cannot bypass grouping protection from the unplanned pool', async () => {
  const f = await prepare({ normal: true, savedSources: false });
  await query('UPDATE order_dependency_lines SET loaded_quantity=1 WHERE dependency_id=$1', [f.dependencyId]);
  const baseline = await stored(f.plan.id);
  const saved = await save(f, { orders: [f.group], trucks: [], summary: {} }, false);
  assert.equal(saved.response.status, 202, JSON.stringify(saved.payload));
  assert.equal(saved.payload.code, 'DISPATCH_PLAN_RECOVERY_SAVED');
  assert.equal(saved.payload.applied, false);
  assert.equal(saved.payload.validationIssues[0].code, 'ORDER_DEPENDENCY_STRUCTURE_LOCK');
  assert.equal((await stored(f.plan.id)).revision, baseline.revision);
  assert.equal((await query('SELECT dispatch_target_ref FROM order_dependencies WHERE id=$1', [f.dependencyId])).rows[0].dispatch_target_ref, f.members[0]);
});
