import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before as beforeAll, after } from 'node:test';
import { query } from '../../../src/db.js';
import { createDispatchV2Fixture } from '../../dispatch/support/dispatch-v2-fixture.js';
import { seedLinkGroup, linkCommand } from '../../support/link-to-fix-fixture.mjs';
import { stored } from '../../support/order-update-save-fixture.mjs';
import { createOrderDependency, enrichDispatchOrdersWithDependencies } from '../../../src/order-dependency-repository.js';
import { dispatchV2FollowupTick } from '../../../src/server.js';
import { getLocalCoOrder, upsertLocalCoOrder } from '../../../src/dispatch-repository.js';

let http;
beforeAll(async () => {
  http = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks(plate,active) VALUES('EXISTING-GROUP',true)");
});
after(async () => { await http?.close(); });

async function fixture() {
  const f = await seedLinkGroup();
  await query('DELETE FROM local_co_orders WHERE co_ref=$1', [f.coRef]);
  await query("UPDATE sales_orders SET dispatch_address='100 Customer Road' WHERE tranid=ANY($1)", [f.members]);
  f.group = { ...f.group, address: '100 Customer Road',
    childOrderDetails: f.group.childOrderDetails.map(child => ({ ...child, sourceYard: '150',
      pickupLocations: ['150'], address: '100 Customer Road' })) };
  await query('UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1', [f.groupRef, JSON.stringify(f.group)]);
  const command = await linkCommand(f, { planDate: f.plan.planDate });
  f.dependency = await createOrderDependency({ dispatchTargetRef: f.groupRef,
    planDate: f.plan.planDate, targetSignature: command.targetSignature, ...command.payload });
  [f.group] = await enrichDispatchOrdersWithDependencies([f.group]);
  // The group exists globally; it has never been part of this saved plan.
  await query("UPDATE dispatch_plan_snapshots SET orders='[]',trucks='[]' WHERE plan_id=$1", [f.plan.id]);
  f.sessionId = `existing-group-${crypto.randomUUID()}`;
  f.token = await http.acquireLease({ planDate: f.plan.planDate, sessionId: f.sessionId });
  f.draft = { orders: [f.group], trucks: [{ id: 'EXISTING-GROUP', plate: 'EXISTING-GROUP',
    loads: [{ id: `DIRECT-${f.plan.id}`, name: 'Load 5', stops: [
      { id: 'DIRECT-PICK', type: 'pick', orderId: f.groupRef, orderRefs: [f.groupRef], location: '2967' },
      { id: 'CUSTOMER-DROP', type: 'drop', orderId: f.groupRef, location: '100 Customer Road' }
    ] }] }], summary: {} };
  return f;
}

async function save(f, classic, draft = f.draft) {
  const baseline = await stored(f.plan.id);
  return http.request(classic ? `/api/dispatch/plans/${f.plan.id}` : `/api/dispatch/v2/plans/${f.plan.id}/commands`, {
    method: classic ? 'PUT' : 'POST', headers: { 'x-dispatch-edit-lease': f.token },
    body: classic ? { ...baseline, ...draft, editLeaseToken: f.token, commandId: crypto.randomUUID(),
      baseRevision: baseline.revision, baseDigest: baseline.digest, audit: { sessionId: f.sessionId } }
      : { commandId: crypto.randomUUID(), baseRevision: baseline.revision, baseDigest: baseline.digest,
        sessionId: f.sessionId, commandType: 'replace_plan', payload: { planDate: f.plan.planDate, ...draft } }
  });
}

const allocations = async id => (await query(`SELECT sales_line_id,transfer_outbound_line_id,
  dispatch_target_line_key,allocated_quantity,loaded_quantity,delivered_quantity,locally_received_quantity
  FROM order_dependency_lines WHERE dependency_id=$1 ORDER BY id`, [id])).rows;

for (const classic of [true, false]) {
  test(`${classic ? 'classic' : 'V2'} saves an unchanged globally linked group absent from the saved plan`, async () => {
    const f = await fixture();
    const before = await allocations(f.dependency.id);
    const result = await save(f, classic);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal((await dispatchV2FollowupTick()).failed, 0);
    const plan = await stored(f.plan.id);
    const dependency = (await query('SELECT dispatch_target_ref,transfer_order_ref,planned_plan_id FROM order_dependencies WHERE id=$1', [f.dependency.id])).rows[0];
    assert.equal(dependency.dispatch_target_ref, f.groupRef);
    assert.equal(dependency.transfer_order_ref, f.transferRef);
    assert.equal(dependency.planned_plan_id, String(f.plan.id));
    assert.deepEqual(await allocations(f.dependency.id), before);
    assert.equal((await query('SELECT dispatch_planned FROM transfer_orders WHERE netsuite_id=$1', [f.transferId])).rows[0].dispatch_planned, false);
    assert.deepEqual(plan.orders.find(o => o.id === f.groupRef).childOrders, f.members);
    const stops = plan.trucks[0].loads[0].stops;
    assert.ok(stops.findIndex(s => s.type === 'pick' && s.location === '2967') < stops.findIndex(s => s.type === 'drop'));
  });
}

for (const classic of [true, false]) {
  test(`${classic ? 'classic' : 'V2'} still rejects changing a linked persisted group's members`, async () => {
    const f = await fixture();
    const before = await stored(f.plan.id);
    const lineState = await allocations(f.dependency.id);
    const group = { ...f.group, childOrders: f.members.slice(0, 1), childOrderDetails: f.group.childOrderDetails.slice(0, 1) };
    const result = await save(f, classic, { ...f.draft, orders: [group] });
    assert.equal(result.response.status, 202, JSON.stringify(result.payload));
    assert.equal(result.payload.applied, false);
    assert.equal(result.payload.validationIssues[0].code, 'ORDER_DEPENDENCY_STRUCTURE_LOCK');
    assert.equal((await stored(f.plan.id)).revision, before.revision);
    assert.deepEqual(await allocations(f.dependency.id), lineState);
  });
}

test('an unchanged linked group still requires its direct pickup before delivery', async () => {
  const f = await fixture();
  f.draft.trucks[0].loads[0].stops.shift();
  const before = await stored(f.plan.id);
  const result = await save(f, false);
  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  assert.equal(result.payload.applied, false);
  assert.ok(result.payload.validationIssues.some(issue => /PICKUP|DEPENDENCY/u.test(issue.code)), JSON.stringify(result.payload));
  assert.equal((await stored(f.plan.id)).revision, before.revision);
});

for (const classic of [true, false]) {
  for (const coFirst of [true, false]) {
    test(`${classic ? 'classic' : 'V2'} retains direct pickup with informational CO ${coFirst ? 'first' : 'last'}`, async () => {
      const f = await fixture();
      const local = await upsertLocalCoOrder({ sourceOrderRef: f.groupRef, fromYard: '150', toYard: '2967', order: f.group });
      await query("UPDATE local_co_orders SET status='received',received_at=now() WHERE co_ref=$1", [local.co_ref]);
      const co = { ...f.group, id: local.co_ref, type: 'CO', sourceTable: 'local_co_orders', sourceOrderId: f.groupRef,
        sourceYard: '150', pickupLocations: ['150'], destinationYard: '2967', address: '2967 Kennedy Road',
        orderDependencies: [], directPickupManifest: [] };
      await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1', [f.plan.id, JSON.stringify([f.group])]);
      f.draft.orders = coFirst ? [co, f.group] : [f.group, co];
      const cargoBefore = await getLocalCoOrder(local.co_ref);
      const lineState = await allocations(f.dependency.id);
      const result = await save(f, classic);
      assert.equal(result.response.status, 200, JSON.stringify(result.payload));
      assert.equal((await dispatchV2FollowupTick()).failed, 0);
      const saved = await stored(f.plan.id);
      assert.ok(saved.orders.some(order => order.id === f.groupRef));
      assert.ok(saved.orders.some(order => order.id === local.co_ref));
      assert.deepEqual(await allocations(f.dependency.id), lineState);
      assert.deepEqual(await getLocalCoOrder(local.co_ref), cargoBefore);
      assert.ok(saved.trucks[0].loads[0].stops.some(stop => stop.type === 'pick' && stop.location === '2967'));
    });
  }
}

for (const classic of [true, false]) {
  test(`${classic ? 'classic' : 'V2'} can remove unrelated TOB01183 while the group retains its direct pickup`, async () => {
    const f = await fixture();
    const local = await upsertLocalCoOrder({ sourceOrderRef: f.groupRef, fromYard: '150', toYard: '2967', order: f.group });
    await query("UPDATE local_co_orders SET status='received',received_at=now() WHERE co_ref=$1", [local.co_ref]);
    const co = { ...f.group, id: local.co_ref, type: 'CO', sourceTable: 'local_co_orders', sourceOrderId: f.groupRef,
      sourceYard: '150', pickupLocations: ['150'], destinationYard: '2967', address: '2967 Kennedy Road',
      orderDependencies: [], directPickupManifest: [] };
    const unrelated = { id: 'TOB01183', type: 'TO', sourceYard: '2967', pickupLocations: ['2967'], destinationYard: '150' };
    const previousTrucks = structuredClone(f.draft.trucks);
    previousTrucks[0].loads[0].stops[0].orderRefs.push(unrelated.id);
    previousTrucks[0].loads[0].stops.push({ id: 'UNRELATED-TO-DROP', type: 'drop', orderId: unrelated.id, location: '150' });
    await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1',
      [f.plan.id, JSON.stringify([co, f.group, unrelated]), JSON.stringify(previousTrucks)]);
    f.draft.orders = [f.group, co];
    const lineState = await allocations(f.dependency.id);
    const result = await save(f, classic);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal((await dispatchV2FollowupTick()).failed, 0);
    const saved = await stored(f.plan.id);
    assert.equal(saved.trucks.some(truck => truck.loads.some(load => load.stops.some(stop => stop.orderId === unrelated.id))), false);
    assert.ok(saved.orders.some(order => order.id === f.groupRef));
    assert.deepEqual(await allocations(f.dependency.id), lineState);
  });
}
