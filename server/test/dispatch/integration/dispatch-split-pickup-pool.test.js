import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test, { after } from 'node:test';
import { parse } from 'espree';
import fc from 'fast-check';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { syncDispatchDeliveryGroupsFromPlan, reconcileDispatchGlobalOrderSources } from '../../../src/dispatch-delivery-group-repository.js';
import { listDispatchOrderPool, upsertDispatchOrderCatalog } from '../../../src/dispatch-order-catalog-repository.js';
import { applyActiveTransitCoMetadata, clearCancelledTransitCoMetadata } from '../../../src/dispatch-planner-performance.js';

after(closeDb);
const filename = new URL('../../../src/server.js', import.meta.url);
const source = readFileSync(filename, 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true }).body;
const context = vm.createContext({ query, isNetSuiteSandboxEnvironment: () => true,
  applyActiveTransitCoMetadata, clearCancelledTransitCoMetadata });
for (const name of ['isSnapshotDerivedDispatchOrder', 'snapshotDerivedGroupBelongsToPlan', 'dispatchOrderLogicalRefs', 'listDispatchSnapshotDerivedOrders']) {
  const node = declarations.find(row => row.type === 'FunctionDeclaration' && row.id.name === name);
  assert.ok(node, name);
  vm.runInContext(source.slice(0, node.range[0]).replace(/[^\n]/g, ' ') + source.slice(...node.range), context, { filename: filename.pathname });
}

let sequence = 0;
async function fixture() {
  const id = 98700000 + (++sequence * 10);
  const parent = `SOB${id}`, first = `${parent}-S1`, second = `${parent}-S2`, other = `SOB${id + 3}`;
  for (const [index, ref] of [parent, first, second, other].entries()) {
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,sales_order_type,netsuite_active)
      VALUES($1,$2,'Split pickup regression',$3,true)`, [id + index, ref, ref === second ? 'Pick-Up' : 'Delivery']);
  }
  const planId = (await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES('2099-09-24','draft',1) RETURNING id")).rows[0].id;
  const original = { id: parent, type: 'SO', sourceTable: 'sales_orders', netsuiteId: id, netsuiteActive: true,
    eligible: true, pallets: 26, address: 'Pickup fixture', items: [] };
  const split = suffix => ({ ...original, id: suffix === 1 ? first : second, originalOrderId: parent,
    pallets: suffix === 1 ? 21 : 5 });
  const extra = { ...original, id: other, netsuiteId: id + 3, pallets: 2 };
  const group = { ...original, id: `GOB-${id}S1-${id + 3}`, pallets: 23,
    childOrders: [first, other], childOrderDetails: [split(1), extra] };
  const plan = { id: planId, planDate: '2099-09-24', revision: 1, orders: [split(1), split(2), group], trucks: [] };
  await upsertDispatchOrderCatalog({ orders: [original, extra], source: 'split-pickup-regression' });
  await syncDispatchDeliveryGroupsFromPlan(plan);
  await query('INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb)',
    [planId, JSON.stringify(plan.orders), '[]', '{}']);
  return { parent, first, second, other, original, group, plan };
}

test('PICKUP-POOL: a live Pick-Up split is excluded despite stale global and catalog eligibility', async () => {
  await withTransaction(async () => {
    const f = await fixture();
    const pool = await listDispatchOrderPool({ type: 'SO', search: f.parent });
    assert.deepEqual(pool.orders.map(row => row.id), [f.group.id]);
    assert.equal(pool.orders[0].pallets, 23);
    assert.equal((await listDispatchOrderPool({ type: 'SO', search: f.second })).orders.length, 0);
    await query('UPDATE dispatch_global_order_splits SET eligible=true WHERE split_ref=$1', [f.second]);
    await reconcileDispatchGlobalOrderSources({ orders: [f.original] });
    assert.equal((await listDispatchOrderPool({ type: 'SO', search: f.second })).orders.length, 0);
    const definitions = (await query('SELECT active FROM dispatch_global_order_splits WHERE split_ref=ANY($1::text[])', [[f.first,f.second]])).rows;
    assert.ok(definitions.every(row => row.active), 'Hiding a pickup must not retire its split');
  }, { rollback: true });
});

test('PICKUP-LEGACY: global definitions and saved snapshots both respect the current split method', async () => {
  await withTransaction(async () => {
    const f = await fixture();
    for (const removeDefinition of [false, true]) {
      if (removeDefinition) { await query('DELETE FROM dispatch_global_order_splits WHERE split_ref=$1', [f.second]); }
      const feed = await context.listDispatchSnapshotDerivedOrders({ type: 'SO', search: f.parent });
      assert.ok(!feed.some(row => row.id === f.second));
      assert.ok(feed.some(row => row.id === f.group.id));
      await query("UPDATE sales_orders SET sales_order_type='Delivery' WHERE tranid=$1", [f.second]);
      const restored = await context.listDispatchSnapshotDerivedOrders({ type: 'SO', search: f.parent });
      assert.ok(restored.some(row => row.id === f.second));
      await query("UPDATE sales_orders SET sales_order_type='Pick-Up' WHERE tranid=$1", [f.second]);
    }
  }, { rollback: true });
});

test('PROPERTY-PICKUP: repeated method changes govern visibility without changing split quantities', async () => {
  await withTransaction(async () => {
    const f = await fixture();
    const before = (await query('SELECT full_order FROM dispatch_global_order_splits WHERE split_ref=$1', [f.second])).rows[0].full_order;
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), async methods => {
      for (const pickup of methods) {
        await query('UPDATE sales_orders SET sales_order_type=$2 WHERE tranid=$1', [f.second, pickup ? 'Pick-Up' : 'Delivery']);
        const pool = await listDispatchOrderPool({ type: 'SO', search: f.second });
        assert.equal(pool.orders.some(row => row.id === f.second), !pickup);
        const legacy = await context.listDispatchSnapshotDerivedOrders({ type: 'SO', search: f.parent });
        assert.equal(legacy.some(row => row.id === f.second), !pickup);
      }
    }), { seed: 120921, numRuns: 20 });
    const afterOrder = (await query('SELECT full_order FROM dispatch_global_order_splits WHERE split_ref=$1', [f.second])).rows[0].full_order;
    assert.deepEqual(afterOrder, before);
  }, { rollback: true });
});
