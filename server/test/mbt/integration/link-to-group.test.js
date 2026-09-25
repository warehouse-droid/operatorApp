import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { seedLinkGroup, linkCommand } from '../../support/link-to-fix-fixture.mjs';
import { getOrderDependencyOptions, createOrderDependency, assertNoActiveOrderDependenciesByRefs,
  syncOrderDependenciesFromDispatchPlan, listOrderDependencies, enrichDispatchOrdersWithDependencies,
  validateDispatchPlanDependencies } from '../../../src/order-dependency-repository.js';
import { rollupGroupedSalesOrderReconciliation } from '../../../src/sales-order-reconciliation.js';
import { reconcileDependencyManagedPickups } from '../../../src/scm-dependency-plan-reconciler.js';

after(closeDb);
const isolated = fn => withTransaction(fn, { rollback: true });
async function fixture({ normal = false } = {}) {
  const f = await seedLinkGroup();
  await query('DELETE FROM local_co_orders WHERE co_ref=$1', [f.coRef]);
  const command = await linkCommand(f, { planDate: f.plan.planDate });
  f.dependency = await createOrderDependency({ dispatchTargetRef: f.groupRef, planDate: f.plan.planDate,
    targetSignature: command.targetSignature, ...command.payload });
  if (normal) {
    await query("DELETE FROM order_dependency_lines WHERE dependency_id=$1 AND sales_line_id <> $2", [f.dependency.id, f.lines[0].id]);
    await query("UPDATE order_dependencies SET dispatch_target_ref=sales_order_ref,dispatch_target_kind='normal' WHERE id=$1", [f.dependency.id]);
    await query("UPDATE order_dependency_lines SET dispatch_target_line_key=$2||'::'||$2||'::'||sales_line_id::text WHERE dependency_id=$1", [f.dependency.id, f.members[0]]);
  }
  return f;
}
const lines = async id => (await query(`SELECT l.sales_line_id,s.sales_order_id,l.allocated_quantity,l.transfer_outbound_line_id,
  l.loaded_quantity,l.delivered_quantity,l.locally_received_quantity FROM order_dependency_lines l
  LEFT JOIN sales_order_lines s ON s.id=l.sales_line_id WHERE l.dependency_id=$1 ORDER BY l.id`, [id])).rows;

test('lowercase TO lookup and linking use the same canonical transfer', () => isolated(async () => {
  const f = await seedLinkGroup();
  await query('DELETE FROM local_co_orders WHERE co_ref=$1', [f.coRef]);
  const options = await getOrderDependencyOptions({ dispatchTargetRef: f.groupRef, planDate: f.plan.planDate,
    transferOrderRef: ` ${f.transferRef.toLowerCase()} ` });
  assert.equal(options.matchError, '');
  assert.equal(options.matchingLines.length, 2);
  const dependency = await createOrderDependency({ dispatchTargetRef: f.groupRef, planDate: f.plan.planDate,
    transferOrderRef: f.transferRef.toLowerCase(), targetSignature: options.targetSignature,
    allocations: options.matchingLines.map(line => ({ targetLineKey: line.targetLineKey, quantities: line.suggestedQuantities })) });
  assert.equal(dependency.transferOrderRef, f.transferRef);
}));

test('case-insensitive lookup preserves the stored TO reference used by execution checks', () => isolated(async () => {
  const f = await seedLinkGroup();
  await query('DELETE FROM local_co_orders WHERE co_ref=$1', [f.coRef]);
  f.transferRef = f.transferRef.toLowerCase();
  await query('UPDATE transfer_orders SET tranid=$2 WHERE netsuite_id=$1', [f.transferId, f.transferRef]);
  const options = await getOrderDependencyOptions({ dispatchTargetRef: f.groupRef, planDate: f.plan.planDate,
    transferOrderRef: f.transferRef.toUpperCase() });
  assert.equal(options.matchError, '');
  assert.equal(options.matchingLines.length, 2);
  const dependency = await createOrderDependency({ dispatchTargetRef: f.groupRef, planDate: f.plan.planDate,
    transferOrderRef: f.transferRef.toUpperCase(), targetSignature: options.targetSignature,
    allocations: options.matchingLines.map(line => ({ targetLineKey: line.targetLineKey, quantities: line.suggestedQuantities })) });
  assert.equal(dependency.transferOrderRef, f.transferRef);
}));

test('case-insensitive fallback rejects closed and missing TO references without allocating', () => isolated(async () => {
  const f = await seedLinkGroup();
  await query("UPDATE transfer_orders SET status='H',status_text='Closed' WHERE netsuite_id=$1", [f.transferId]);
  const options = { dispatchTargetRef: f.groupRef, planDate: f.plan.planDate, transferOrderRef: f.transferRef.toLowerCase() };
  const closed = await getOrderDependencyOptions(options);
  assert.match(closed.matchError, /closed/iu);
  assert.equal(closed.matchingLines.length, 0);
  const missing = await getOrderDependencyOptions({ ...options, transferOrderRef: ' to-missing ' });
  assert.equal(missing.matchError, 'Transfer Order TO-MISSING was not found.');
  assert.equal((await query('SELECT id FROM order_dependencies WHERE transfer_order_id=$1', [f.transferId])).rowCount, 0);
}));

test('group refresh retains direct pickup and produces a route accepted by dependency save validation', () => isolated(async () => {
  const f = await fixture();
  f.group.sourceYard = '150';
  f.group.pickupLocations = ['150'];
  f.group.childOrderDetails.forEach(child => { child.pickupLocations = ['150']; });
  const [linked] = await enrichDispatchOrdersWithDependencies([f.group]);
  const refreshed = rollupGroupedSalesOrderReconciliation(linked, linked.childOrderDetails);
  const plan = { id: f.plan.id, planDate: f.plan.planDate, orders: [refreshed], trucks: [{ id: 'T', plate: 'T',
    loads: [{ id: 'L', stops: [{ id: 'DROP', type: 'drop', orderId: f.groupRef }] }] }] };
  const routed = reconcileDependencyManagedPickups({ plan, enrichedOrders: plan.orders, affectedTargetRefs: [f.groupRef] });
  assert.deepEqual(await validateDispatchPlanDependencies(routed), []);
  assert.ok(routed.trucks[0].loads[0].stops.some(stop => stop.type === 'pick' && stop.location === '2967'));
}));

test('direct link moves to a new group atomically and idempotently without reallocating its child lines', () => isolated(async () => {
  const f = await fixture({ normal: true });
  const before = await lines(f.dependency.id);
  const options = { allowNormalGroupingRefs: f.members, allowEstablishedGroupTargets: f.members.map(sourceOrderRef => ({ sourceOrderRef, groupRef: f.groupRef })) };
  await assertNoActiveOrderDependenciesByRefs(f.members, 'group these orders', options);
  const plan = { id: f.plan.id, planDate: f.plan.planDate, orders: [f.group], trucks: [] };
  const result = await syncOrderDependenciesFromDispatchPlan(plan);
  assert.equal(result.remapped.length, 1);
  const current = (await listOrderDependencies({ transferOrderRef: f.transferRef }))[0];
  assert.equal(current.dispatchTargetRef, f.groupRef);
  assert.equal(current.dispatchTargetKind, 'group');
  assert.deepEqual(await lines(f.dependency.id), before);
  const keys = (await query('SELECT dispatch_target_line_key FROM order_dependency_lines WHERE dependency_id=$1', [f.dependency.id])).rows;
  assert.ok(keys.every(row => row.dispatch_target_line_key.startsWith(`${f.groupRef}::${f.members[0]}::`)));
  assert.equal((await syncOrderDependenciesFromDispatchPlan(plan)).remapped.length, 0);
}));

test('direct grouping fails closed without a proven group transition or after execution', () => isolated(async () => {
  const f = await fixture({ normal: true });
  const options = { allowNormalGroupingRefs: f.members, allowEstablishedGroupTargets: [{ sourceOrderRef: f.members[0], groupRef: f.groupRef }] };
  await assert.rejects(assertNoActiveOrderDependenciesByRefs(f.members, 'split'), { code: 'ORDER_DEPENDENCY_STRUCTURE_LOCK' });
  await query('UPDATE order_dependency_lines SET loaded_quantity=1 WHERE dependency_id=$1', [f.dependency.id]);
  await assert.rejects(assertNoActiveOrderDependenciesByRefs(f.members, 'group', options), { code: 'ORDER_DEPENDENCY_STRUCTURE_LOCK' });
  assert.equal((await syncOrderDependenciesFromDispatchPlan({ id: f.plan.id, planDate: f.plan.planDate, orders: [f.group], trucks: [] })).remapped.length, 0);
  assert.equal((await listOrderDependencies({ transferOrderRef: f.transferRef }))[0].dispatchTargetRef, f.members[0]);
}));

test('rolled-back grouping restores dependency identity and line keys', () => isolated(async () => {
  const f = await fixture({ normal: true });
  const before = (await query('SELECT * FROM order_dependency_lines WHERE dependency_id=$1 ORDER BY id', [f.dependency.id])).rows;
  await withTransaction(async () => {
    const result = await syncOrderDependenciesFromDispatchPlan({ id: f.plan.id, planDate: f.plan.planDate, orders: [f.group], trucks: [] });
    assert.equal(result.remapped.length, 1);
  }, { rollback: true });
  assert.equal((await listOrderDependencies({ transferOrderRef: f.transferRef }))[0].dispatchTargetRef, f.members[0]);
  assert.deepEqual((await query('SELECT * FROM order_dependency_lines WHERE dependency_id=$1 ORDER BY id', [f.dependency.id])).rows, before);
}));
