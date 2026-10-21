import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { beginRollbackContext,closeDb,query } from "../../../src/db.js";
import { applyDispatchV2Command } from "../../../src/dispatch-planner-v2-repository.js";
import { syncDispatchDeliveryGroupsFromPlan,deactivateDispatchGlobalOrderDefinitions } from "../../../src/dispatch-delivery-group-repository.js";

after(closeDb);
async function retiredHistory(fn) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(async () => {
    const suffix = crypto.randomUUID().slice(0,8);
    const date = `1910-${String(1+Number.parseInt(suffix.slice(0,2),16)%12).padStart(2,"0")}-${String(1+Number.parseInt(suffix.slice(2,4),16)%28).padStart(2,"0")}`;
    const header = (await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES($1,'draft',1) RETURNING id",[date])).rows[0];
    const order = {id: `SO-HISTORY-${suffix}-S1`,type: "SO",originalOrderId: `SO-HISTORY-${suffix}`,
      isSplit: true,pallets: 1,layers: 0,pickupLocations: ["3445"],sourceYard: "3445",address: "100 History Street",items: []};
    const trucks = [{id: "history-truck",plate: "HISTORY",loads: [{id: "history-load",stops: [
      {id: "history-pick",type: "pick",location: "3445"},
      {id: "history-drop",type: "drop",orderId: order.id,dropAddress: order.address}]}]}];
    const plan = {id: String(header.id),planDate: date,revision: 1,status: "draft",orders: [order],trucks,summary: {}};
    await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,'{}')",
      [header.id,JSON.stringify(plan.orders),JSON.stringify(trucks)]);
    await syncDispatchDeliveryGroupsFromPlan(plan);
    await deactivateDispatchGlobalOrderDefinitions([order.id]);
    await fn(plan);
  }); } finally { await rollback.rollback(); }
}

test("unchanged historical snapshot saves without reviving a later-retired split",async () => {
  await retiredHistory(async plan => {
    const applied = await applyDispatchV2Command({planId: plan.id,command: {commandId: crypto.randomUUID(),
      commandType: "replace_plan",baseRevision: 1,compactReceipt: true,
      payload: {orders: plan.orders,trucks: plan.trucks,summary: plan.summary}}});
    assert.equal(applied.payload.plan.revision,2);
    const stored = (await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1",[plan.id])).rows[0];
    assert.equal(stored.orders[0].id,plan.orders[0].id);
    assert.equal(stored.orders[0].pallets,1);
    assert.equal(stored.trucks[0].loads[0].stops.find(stop => stop.type === "drop").orderId,plan.orders[0].id);
    assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1",[plan.orders[0].id])).rows[0].active,false);
  });
});

test("changing historical retired cargo still fails instead of treating it as the retained board",async () => {
  await retiredHistory(async plan => {
    await assert.rejects(applyDispatchV2Command({planId: plan.id,command: {commandId: crypto.randomUUID(),
      commandType: "replace_plan",baseRevision: 1,compactReceipt: true,
      payload: {orders: [{...plan.orders[0],pallets: 2}],trucks: plan.trucks,summary: plan.summary}}}),
    error => error.code === "DISPATCH_DERIVED_ORDER_RETIRED");
  });
});
