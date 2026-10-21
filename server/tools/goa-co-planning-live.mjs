// Invoke inside the app with GOA_CO_READ_ONLY=1. PostgreSQL enforces read-only.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.GOA_CO_READ_ONLY, '1');
const runtime = name => import(pathToFileURL(resolve('src', name)).href);
const { query, withTransaction, closeDb } = await runtime('db.js');
const { listDispatchOrders, getLocalCoOrder } = await runtime('dispatch-repository.js');
const { getDispatchOrderCatalogOrder } = await runtime('dispatch-order-catalog-repository.js');
const { enrichDispatchOrdersWithDependencies, validateDispatchPlanDependencies } = await runtime('order-dependency-repository.js');
const { dispatchDependencyOrderRefs } = await runtime('yard-dependency-structure.js');

try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='25s'");
    const ref = 'CO-GOA-9611-9612';
    const stored = await getLocalCoOrder(ref);
    assert.ok(stored);
    const [co] = await listDispatchOrders({ type: 'CO', exactOrderRefs: [ref] });
    assert.ok(co);
    assert.equal(co.sourceYard, stored.from_location);
    assert.equal(co.destinationYard, stored.to_location);
    assert.equal(co.sourceYard, '2967');
    assert.equal(co.destinationYard, '3445');
    assert.deepEqual(co.pickupLocations, ['2967']);
    const catalog = await getDispatchOrderCatalogOrder(ref);
    if (catalog) {
      assert.equal(catalog.sourceYard, '2967');
      assert.equal(catalog.destinationYard, '3445');
    }
    const [enriched] = await enrichDispatchOrdersWithDependencies([co]);
    assert.equal(enriched.orderDependencies?.length || 0, 0);
    assert.deepEqual(dispatchDependencyOrderRefs(co), [ref]);
    const planDate = new Date().toISOString().slice(0, 10);
    const plan = { planDate, orders: [co], trucks: [{ id: 'READ-ONLY-CO-CHECK', loads: [{ id: 'CO-CHECK', stops: [
      { type: 'pick', location: '2967', orderId: ref, orderRefs: [ref] },
      { type: 'drop', orderId: ref }
    ] }] }] };
    assert.deepEqual(await validateDispatchPlanDependencies(plan), []);
    const transfer = (await query('SELECT tranid,dispatch_planned,dispatch_plan_date FROM transfer_orders WHERE tranid=$1', ['TOB01180'])).rows[0];
    assert.deepEqual(await getLocalCoOrder(ref), stored);
    return { passed: true, readOnly: true, order: ref, sourceYard: co.sourceYard,
      destinationYard: co.destinationYard, pickupLocations: co.pickupLocations,
      dependencyRefs: dispatchDependencyOrderRefs(co), dependencies: enriched.orderDependencies?.length || 0,
      coOnlyPlanningConflicts: [], transfer };
  }, { rollback: true });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
