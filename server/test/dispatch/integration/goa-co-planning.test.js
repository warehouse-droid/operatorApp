import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { getLocalCoOrder, listDispatchOrders, upsertLocalCoOrder } from '../../../src/dispatch-repository.js';
import { getDispatchOrderCatalogOrder, upsertDispatchOrderCatalog } from '../../../src/dispatch-order-catalog-repository.js';
import { enrichDispatchOrdersWithDependencies, validateDispatchPlanDependencies,
  syncOrderDependenciesFromDispatchPlan } from '../../../src/order-dependency-repository.js';
import { executeScmDependencyCommand } from '../../../src/scm-dependency-command-service.js';
import { createDispatchPlan, saveDispatchPlanSnapshot } from '../../../src/dispatch-plan-repository.js';
import { command, seed, sources } from '../../support/co-direct-to-fixture.mjs';

after(closeDb);
const rollback = run => withTransaction(run, { rollback: true });

async function fixture() {
  const f = await seed();
  await query("INSERT INTO dispatch_trucks(plate,active) VALUES('CO-TRUCK',true)");
  await query("UPDATE sales_orders SET operator_status='open' WHERE netsuite_id=$1", [f.salesId]);
  await query('UPDATE sales_order_lines SET confirmed=false,confirmed_at=null,packed_sales_qty=0 WHERE sales_order_id=$1', [f.salesId]);
  const linked = await executeScmDependencyCommand(await command(f, { mode: 'yard_replenishment' }));
  f.dependencyId = linked.dependencyId;
  f.groupRef = `GOA-CO-REG-${f.salesId}`;
  const items = [{ lineRowId: f.materialId, lineId: 1, itemId: 1356, itemName: 'TREVISTA',
    quantity: 52.25, layers: 5, toLyr: 10.45, unit: 'SQFT' }];
  f.group = { id: f.groupRef, type: 'SO', sourceYard: '3445', pickupLocations: ['3445'],
    childOrders: [f.salesRef], childOrderDetails: [{ id: f.salesRef, type: 'SO', sourceYard: '3445',
      pickupLocations: ['3445'], items }], items, address: '100 Customer Road' };
  f.co = await upsertLocalCoOrder({ sourceOrderRef: f.groupRef, fromYard: '2967', toYard: '3445', order: f.group });
  f.coOrder = { ...f.group, id: f.co.co_ref, type: 'CO', sourceTable: 'local_co_orders', sourceOrderId: f.groupRef,
    sourceYard: '2967', pickupLocations: ['2967'], destinationYard: '3445', address: '3445 Kennedy Road, Toronto, ON' };
  await query("UPDATE order_dependencies SET dispatch_target_ref=$2,dispatch_target_kind='group' WHERE id=$1", [f.dependencyId, f.groupRef]);
  f.plan = { planDate: '2097-10-01', orders: [f.group, f.coOrder], trucks: [{ id: 'CO-TRUCK', plate: 'CO-TRUCK',
    loads: [{ id: 'CO-LOAD', name: 'Load 1', stops: [
      { id: 'CO-PICK', type: 'pick', location: '2967', orderId: f.co.co_ref, orderRefs: [f.co.co_ref] },
      { id: 'CO-DROP', type: 'drop', orderId: f.co.co_ref }
    ] }] }] };
  return f;
}

test('GOA CO real Dispatch feed uses 2967 to 3445 even with source children at 3445', () => rollback(async () => {
  const f = await fixture();
  const before = await getLocalCoOrder(f.co.co_ref);
  const [co] = await listDispatchOrders({ type: 'CO', exactOrderRefs: [f.co.co_ref] });
  assert.ok(co);
  assert.equal(co.sourceYard, '2967');
  assert.deepEqual(co.pickupLocations, ['2967']);
  assert.equal(co.destinationYard, '3445');
  assert.equal(Number(co.items[0].quantity), 52.25);
  assert.deepEqual(await getLocalCoOrder(f.co.co_ref), before);
}));

test('GOA CO catalog hydration restores canonical route and keeps independent cargo', () => rollback(async () => {
  const f = await fixture();
  await upsertDispatchOrderCatalog({ orders: [{ ...f.coOrder, sourceYard: '3445', pickupLocations: ['3445'] }] });
  const co = await getDispatchOrderCatalogOrder(f.co.co_ref);
  assert.equal(co.sourceYard, '2967');
  assert.deepEqual(co.pickupLocations, ['2967']);
  assert.equal(co.destinationYard, '3445');
  assert.equal(Number(co.items[0].quantity), 52.25);
}));

test('GOA CO can validate with an unplanned TO and does not inherit its source dependency', () => rollback(async () => {
  const f = await fixture();
  assert.deepEqual(await validateDispatchPlanDependencies(f.plan), []);
  const [co] = await enrichDispatchOrdersWithDependencies([f.coOrder]);
  assert.equal(co.orderDependencies?.length || 0, 0);
  assert.equal(Boolean(co.dependencyWaitingForTransfer), false);
}));

test('GOA CO planning never satisfies or retargets the source delivery dependency', () => rollback(async () => {
  const f = await fixture();
  await syncOrderDependenciesFromDispatchPlan(f.plan);
  const dependency = (await query('SELECT dispatch_target_ref,planned_plan_id,planned_date,planned_load_id FROM order_dependencies WHERE id=$1', [f.dependencyId])).rows[0];
  assert.equal(dependency.dispatch_target_ref, f.groupRef);
  assert.equal(dependency.planned_plan_id, null);
  assert.equal(dependency.planned_date, null);
  assert.equal(dependency.planned_load_id, null);
}));

test('GOA CO and delivery array ordering both retain actual unplanned TO delivery rejection', () => rollback(async () => {
  const f = await fixture();
  f.plan.trucks[0].loads.push({ id: 'DELIVERY-LOAD', name: 'Load 2', stops: [
    { id: 'DELIVERY-PICK', type: 'pick', location: '3445', orderId: f.groupRef },
    { id: 'DELIVERY-DROP', type: 'drop', orderId: f.groupRef }
  ] });
  for (const orders of [[f.group, f.coOrder], [f.coOrder, f.group]]) {
    const conflicts = await validateDispatchPlanDependencies({ ...f.plan, orders });
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0], new RegExp(f.groupRef + ' requires ' + f.transferRef));
  }
}));

test('GOA CO real snapshot save permits CO first while source records remain untouched', () => rollback(async () => {
  const f = await fixture();
  const before = await sources(f);
  const plan = await createDispatchPlan({ planDate: f.plan.planDate });
  const saved = await saveDispatchPlanSnapshot(plan.id, { orders: f.plan.orders, trucks: f.plan.trucks, summary: {} });
  assert.ok(saved.orders.some(order => order.id === f.co.co_ref));
  assert.equal(saved.trucks[0].loads[0].stops.at(-1).orderId, f.co.co_ref);
  assert.deepEqual(await sources(f), before);
}));
