import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";
import { loadDispatchOrdersForResponse } from "../../../src/server.js";
import { deactivateDispatchGlobalOrderDefinitions, reconcileDispatchPlanGlobalOrderDefinitions,
  syncDispatchDeliveryGroupsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import { getDispatchOrderCatalogOrder, listDispatchOrderPool } from "../../../src/dispatch-order-catalog-repository.js";

after(closeDb);

async function scenario(run) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const refs = ["SO-RETIRE-ROOT", "SO-RETIRE-ROOT-S1", "SO-RETIRE-ROOT-S2"];
      for (const [index, ref] of refs.entries()) {
        const id = 817140000 + index;
        await query(`INSERT INTO sales_orders (netsuite_id,tranid,customer,status,status_text,fulfillment_status,
          outbound_location_id,outbound_location,sales_order_type,operator_status,local_yard_order_status,
          dispatch_address,netsuite_active,synced_at)
          VALUES ($1,$2,'Regression','B','Sales Order : Pending Fulfillment','not_fulfilled',1,'3445',
            'Delivery','open','Open','Regression Road',true,now())`, [id, ref]);
        await query(`INSERT INTO sales_order_lines (id,sales_order_id,line_id,item_id,item_name,sku,quantity,unit,item_weight,pallet_qty,netsuite_active)
          VALUES ($1,$2,1,817140900,'Regression','REGRESSION',4,'EA',1,1,true)`, [817141000 + index, id]);
      }
      const sourceOrders = await listDispatchOrders({ type: "SO", exactOrderRefs: refs });
      assert.equal(sourceOrders.length, 3);
      const created = await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES ('2096-09-14','draft',1) RETURNING id");
      const plan = { id: String(created.rows[0].id), planDate: "2096-09-14", revision: 1,
        orders: sourceOrders.filter(row => row.id !== refs[0]).map(row => ({ ...row, originalOrderId: refs[0] })), trucks: [] };
      await syncDispatchDeliveryGroupsFromPlan(plan);
      await run({ refs, plan, sourceOrders });
    });
  } finally { await rollback.rollback(); }
}

test("fresh canonical feed excludes materialized retired split while retaining parent and active sibling", () => scenario(async ({ refs }) => {
  await deactivateDispatchGlobalOrderDefinitions([refs[2]]);
  assert.equal((await listDispatchOrders({ type: "SO", exactOrderRefs: [refs[2]] })).length, 1, "Reproduce the surviving materialized SO");
  const orders = await loadDispatchOrdersForResponse({ type: "SO", search: "SO-RETIRE-ROOT", exactOrderRefs: refs.map(ref => ref.toLowerCase()) });
  assert.equal(orders.some(row => row.id === refs[2]), false, "Authoritative feed must respect retirement");
  assert.ok(orders.some(row => row.id === refs[0]));
  assert.ok(orders.some(row => row.id === refs[1]));
  assert.equal(await getDispatchOrderCatalogOrder(refs[2]), null);
  assert.deepEqual((await listDispatchOrderPool({ search: refs[2] })).orders, []);
  const accepted = await reconcileDispatchPlanGlobalOrderDefinitions({ orders, trucks: [] }, { rejectRetiredGlobalOrderRefs: true });
  assert.deepEqual(accepted.orders.map(row => row.id), orders.map(row => row.id));
}));

test("canonical materialized active split carries global source-plan ownership in fresh feed", () => scenario(async ({ refs, plan }) => {
  const orders = await loadDispatchOrdersForResponse({ type: "SO", exactOrderRefs: [refs[1]] });
  const split = orders.find(row => row.id === refs[1]);
  assert.equal(split?.globalOrderDefinition, true);
  assert.equal(String(split.globalOrderSourcePlanId), plan.id);
  assert.equal(split.globalOrderSourcePlanDate, plan.planDate);
}));

test("lifecycle filtering preserves current canonical packing status and cargo for active materialized splits", () => scenario(async ({ refs }) => {
  for (const status of ["packed", "open"]) {
    await query("UPDATE sales_orders SET operator_status=$2 WHERE tranid=$1", [refs[1], status]);
    const canonical = (await listDispatchOrders({ type: "SO", exactOrderRefs: [refs[1]] })).find(order => order.id === refs[1]);
    assert.equal(canonical.operatorStatus, status);
    const visible = (await loadDispatchOrdersForResponse({ type: "SO", exactOrderRefs: [refs[1]] })).find(order => order.id === refs[1]);
    assert.equal(visible.operatorStatus, status, "Global lifecycle metadata must not overwrite current yard status");
    assert.deepEqual(visible.items, canonical.items);
  }
}));

test("retired orders still reject assigned and unassigned snapshots; explicit reactivation remains allowed", () => scenario(async ({ refs, plan }) => {
  await deactivateDispatchGlobalOrderDefinitions([refs[2]]);
  for (const trucks of [[], [{ id: "T1", loads: [{ id: "L1", stops: [{ orderId: refs[2], type: "drop" }] }] }]]) {
    await assert.rejects(reconcileDispatchPlanGlobalOrderDefinitions({ ...plan, trucks }, { rejectRetiredGlobalOrderRefs: true }),
      error => error.code === "DISPATCH_DERIVED_ORDER_RETIRED" && error.retiredOrderRefs.includes(refs[2]));
  }
  const accepted = await reconcileDispatchPlanGlobalOrderDefinitions(plan, {
    rejectRetiredGlobalOrderRefs: true, reactivatedGlobalOrderRefs: [refs[2].toLowerCase()]
  });
  assert.ok(accepted.orders.some(row => row.id === refs[2]));
  assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [refs[2]])).rows[0].active, false);
}));

test("property: source-feed eligibility and ownership agree with global lifecycle in either state", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), (retired, materialized) => scenario(async ({ refs, plan }) => {
    if (!materialized) { await query("DELETE FROM sales_orders WHERE tranid=$1", [refs[2]]); }
    if (retired) { await deactivateDispatchGlobalOrderDefinitions([refs[2]]); }
    const orders = await loadDispatchOrdersForResponse({ type: "SO", exactOrderRefs: [refs[2]] });
    const split = orders.find(order => order.id === refs[2]);
    assert.equal(Boolean(split), !retired);
    if (!retired) {
      assert.equal(split.globalOrderDefinition, true);
      assert.equal(String(split.globalOrderSourcePlanId), plan.id);
    }
    await reconcileDispatchPlanGlobalOrderDefinitions({ ...plan, orders }, { rejectRetiredGlobalOrderRefs: true });
  })), { seed: 20260914, numRuns: 20 });
});
