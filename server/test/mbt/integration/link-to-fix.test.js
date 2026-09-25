import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { resolveDispatchSalesTarget } from '../../../src/dispatch-order-target-repository.js';
import { getOrderDependencyOptions, syncOrderDependenciesFromDispatchPlan } from '../../../src/order-dependency-repository.js';
import { executeScmDependencyCommand } from '../../../src/scm-dependency-command-service.js';
import { previewScmDependencyMutation } from '../../../src/scm-dependency-preview-service.js';
import { getDeliveryOrder, listDeliveryOrders, listDeliveryLoadOrders, listDeliveryLoadTrucks,
  getDeliveryPrepNotifications } from '../../../src/delivery-repository.js';
import { seedLinkGroup, linkCommand, linkAndPlan, completedSharedCo, protectedCoHistory } from '../../support/link-to-fix-fixture.mjs';
after(closeDb);
const isolated = run => withTransaction(run, { rollback: true });

test('L1 global group matches and links TO on a date without a group snapshot', () => isolated(async () => {
  const f = await seedLinkGroup();
  const options = await getOrderDependencyOptions({ dispatchTargetRef: f.groupRef, transferOrderRef: f.transferRef, planDate: f.nextDate });
  assert.equal(options.dispatchTargetKind, 'group');
  assert.equal(options.matchError, '');
  assert.deepEqual(options.matchingLines.map(line => Number(line.suggestedQuantity)), [4, 6]);
  const result = await executeScmDependencyCommand(await linkCommand(f));
  assert.equal(result.dependency.dispatchTargetRef, f.groupRef);
  assert.deepEqual(result.dependency.lines.filter(line => line.salesLineId).map(line => Number(line.allocatedQuantity)).sort(), [4, 6]);
}));

test('L1 global definition supersedes stale snapshots and retired groups stay unavailable', () => isolated(async () => {
  const f = await seedLinkGroup();
  const original = await resolveDispatchSalesTarget({ dispatchTargetRef: f.groupRef, planDate: f.plan.planDate });
  const next = { ...f.group, childOrders: [f.members[0]], childOrderDetails: [f.group.childOrderDetails[0]] };
  await query('UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1', [f.groupRef, JSON.stringify(next)]);
  const current = await resolveDispatchSalesTarget({ dispatchTargetRef: f.groupRef, planDate: f.plan.planDate });
  assert.deepEqual(current.target.memberRefs, [f.members[0]]);
  assert.notEqual(current.signature, original.signature);
  await query('UPDATE dispatch_global_order_groups SET active=false WHERE group_ref=$1', [f.groupRef]);
  await assert.rejects(resolveDispatchSalesTarget({ dispatchTargetRef: f.groupRef, planDate: f.plan.planDate }), /retired|inactive/i);
}));

test('L1 source quantity refresh changes the signature and rejects a stale link without writes', () => isolated(async () => {
  const f = await seedLinkGroup();
  const command = await linkCommand(f, { planDate: f.plan.planDate });
  await query('UPDATE sales_order_lines SET quantity=8,netsuite_backordered_qty=8 WHERE id=$1', [f.lines[0].id]);
  const resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: f.groupRef, planDate: f.nextDate });
  assert.equal(resolved.lines.find(line => line.salesLineId === Number(f.lines[0].id)).quantity, 8);
  await assert.rejects(executeScmDependencyCommand(command), error => /changed|stale/i.test(error.message));
  assert.equal((await query('SELECT count(*)::int AS n FROM order_dependencies WHERE transfer_order_id=$1', [f.transferId])).rows[0].n, 0);
}));

test('L2 received CO and its proven shared pickup do not block a fresh customer-leg TO link', () => isolated(async () => {
  const f = await completedSharedCo(await seedLinkGroup());
  const before = await protectedCoHistory(f);
  const command = await linkCommand(f, { planDate: f.plan.planDate });
  const preview = await previewScmDependencyMutation(command);
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  const result = await executeScmDependencyCommand(command);
  assert.equal(result.dependency.transferOrderRef, f.transferRef);
  assert.deepEqual(await protectedCoHistory(f), before);
}));

test('L2 active CO, absent arrival evidence and real SO packing still block linking', () => isolated(async () => {
  const f = await completedSharedCo(await seedLinkGroup());
  const command = await linkCommand(f, { planDate: f.plan.planDate });
  for (const sql of ["UPDATE local_co_orders SET received_at=NULL,details=details-'driverCompletionRecordId' WHERE co_ref=$1",
    "UPDATE local_co_orders SET status='loaded' WHERE co_ref=$1"]) {
    await withTransaction(async () => {
      await query(sql, [f.coRef]);
      const preview = await previewScmDependencyMutation(command);
      assert.ok(preview.blockers.some(row => row.code === 'OPERATOR_ACTIVITY_STARTED'));
    }, { rollback: true });
  }
  await query('UPDATE sales_order_lines SET packed_piece_qty=1 WHERE id=$1', [f.lines[0].id]);
  assert.ok((await previewScmDependencyMutation(command)).blockers.some(row => row.code === 'OPERATOR_ACTIVITY_STARTED'));
}));

test('L2 incomplete shared-pickup evidence stays blocked', () => isolated(async () => {
  const f = await completedSharedCo(await seedLinkGroup());
  const command = await linkCommand(f, { planDate: f.plan.planDate });
  for (const change of ['wrong-yard', 'unknown-ref', 'missing-stop', 'real-so-pickup']) {
    await withTransaction(async () => {
      if (change === 'wrong-yard') {await query("UPDATE driver_job_records SET job_details=jsonb_set(job_details,'{location}','\"3445\"') WHERE id=$1", [f.pickup.id]);}
      if (change === 'unknown-ref') {await query("UPDATE driver_job_records SET order_refs=order_refs||'\"UNEXPLAINED\"'::jsonb WHERE id=$1", [f.pickup.id]);}
      if (change === 'missing-stop') {await query("UPDATE driver_job_records SET stop_id='missing' WHERE id=$1", [f.pickup.id]);}
      if (change === 'real-so-pickup') {await query("UPDATE driver_job_records SET stop_id='customer-pick',order_refs=$2::jsonb WHERE id=$1", [f.pickup.id, JSON.stringify(f.members)]);}
      const preview = await previewScmDependencyMutation(command);
      assert.ok(preview.blockers.some(row => row.code === 'DRIVER_ACTIVITY_STARTED'), change);
    }, { rollback: true });
  }
}));

test('L3 linked TO inherits confirmed group assignment in list/detail/load/notifications without independent planning flags', () => isolated(async () => {
  const f = await seedLinkGroup();
  await linkAndPlan(f);
  const base = (await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1', [f.transferId])).rows[0];
  const list = await listDeliveryOrders({ locationId: 28, orderType: 'transfer_order', planDate: f.nextDate, truckPlate: 'LINK-TRUCK' });
  const card = list.find(row => row.tranid === f.transferRef);
  assert.ok(card, 'linked TO must appear in its source-yard planned batch');
  for (const row of [card, await getDeliveryOrder(f.transferId)]) {
    assert.equal(row.dispatch_planned, true);
    assert.equal(new Date(row.dispatch_plan_date).toISOString().slice(0, 10), f.nextDate);
    assert.equal(row.dispatch_truck_plate, 'LINK-TRUCK');
    assert.equal(row.dispatch_load_name, 'Linked Load');
    assert.equal(row.dispatch_parking_spot, 'Spot 7');
  }
  assert.ok((await listDeliveryLoadOrders({ locationId: 28, planDate: f.nextDate, truckPlate: 'LINK-TRUCK' })).some(row => row.tranid === f.transferRef));
  assert.ok((await listDeliveryLoadTrucks({ locationId: 28, planDate: f.nextDate })).some(row => row.truck_plate === 'LINK-TRUCK'));
  assert.ok((await getDeliveryPrepNotifications({ locationId: 28 })).items.some(row => row.tranid === f.transferRef && row.dispatchPlanned));
  assert.ok(!(await listDeliveryOrders({ locationId: 26, orderType: 'transfer_order', planDate: f.nextDate })).some(row => row.tranid === f.transferRef));
  assert.equal(base.dispatch_planned, false);
  assert.deepEqual((await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1', [f.transferId])).rows[0], base);
}));

test('L3 cancelled/draft plans, cancelled links and unplanned targets do not remain planned', () => isolated(async () => {
  const f = await seedLinkGroup();
  await linkAndPlan(f);
  for (const change of ['draft', 'cancelled', 'unlink', 'unplan', 'replenishment']) {
    await withTransaction(async () => {
      if (['draft', 'cancelled'].includes(change)) {await query('UPDATE dispatch_plans SET status=$2 WHERE id=$1', [f.deliveryPlan.id, change]);}
      if (change === 'unlink') {await query("UPDATE order_dependencies SET status='cancelled' WHERE id=$1", [f.dependency.id]);}
      if (change === 'replenishment') {await query("UPDATE order_dependencies SET dependency_mode='yard_replenishment' WHERE id=$1", [f.dependency.id]);}
      if (change === 'unplan') {await syncOrderDependenciesFromDispatchPlan({ ...f.deliveryPlan, trucks: [] });}
      assert.equal((await getDeliveryOrder(f.transferId)).dispatch_planned, false, change);
      assert.ok(!(await listDeliveryLoadOrders({ locationId: 28, planDate: f.nextDate })).some(row => row.tranid === f.transferRef), change);
    }, { rollback: true });
  }
}));
