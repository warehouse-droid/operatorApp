import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { beginRollbackContext,closeDb,query } from "../../../src/db.js";
import { applyDispatchV2Command } from "../../../src/dispatch-planner-v2-repository.js";
import { hydrateHistoricalDispatchPlanOrders } from "../../../src/dispatch-historical-order-snapshots.js";

after(closeDb);
async function board(fn,{evidenceAt = "2026-09-15T12:00:00Z"} = {}) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(async () => {
    const ref = `SO-HISTORY-CARD-${crypto.randomUUID().slice(0,8)}`;
    const header = (await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES('1910-01-01','draft',1) RETURNING id")).rows[0];
    const original = {id: ref,type: "SO",pallets: 8,pickupLocations: ["3445"],sourceYard: "3445",items: [{itemId: 1,pallets: 8,quantity: 8}]};
    const trucks = [{id: "truck",plate: "HISTORY",loads: [{id: "load",pickupVisitSchemaVersion: 1,stops: [
      {id: "pick",type: "pick",location: "3445",orderRefs: [ref]},
      {id: "drop",type: "drop",orderId: ref}]}]}];
    const part = {...original,id: `${ref}-S1`,originalOrderId: ref,pallets: 3,items: [{itemId: 1,pallets: 3,quantity: 3}]};
    const plan = {id: String(header.id),planDate: "1910-01-01",status: "draft",revision: 1,
      savedAt: "2026-09-15T15:00:00Z",orders: [part],trucks,summary: {}};
    await query(`INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary,saved_at)
      VALUES($1,$2::jsonb,$3::jsonb,'{}',$4)`,[header.id,JSON.stringify(plan.orders),JSON.stringify(trucks),plan.savedAt]);
    const history = (await query(`INSERT INTO dispatch_plan_snapshot_history(plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archived_at)
      VALUES($1,'1910-01-01',0,$2::jsonb,$3::jsonb,'{}',$4,$4) RETURNING id`,
    [header.id,JSON.stringify([original]),JSON.stringify(trucks),evidenceAt])).rows[0];
    await fn(plan,original,history);
  }); } finally { await rollback.rollback(); }
}

test("history hydrates a missing routed parent from the latest preceding retained full order",async () => {
  await board(async (plan,original,history) => {
    const hydrated = await hydrateHistoricalDispatchPlanOrders(plan);
    assert.deepEqual(hydrated.plan.orders.find(order => order.id === original.id),original);
    assert.equal(hydrated.reconstructed[0]?.sourceId,String(history.id));
    assert.equal(plan.orders.length,1,"reading history must not mutate the caller's board");
  });
});

test("the newest September card takes precedence over conflicting August and July snapshots",async () => {
  await board(async (plan,original,history) => {
    for (const [date,pallets] of [["2026-07-30T12:00:00Z",3],["2026-08-30T12:00:00Z",6]]) {
      const older = {...original,pallets,items: [{itemId: 1,pallets,quantity: pallets}]};
      await query(`INSERT INTO dispatch_plan_snapshot_history(plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archived_at)
        VALUES($1,'1910-01-01',0,$2::jsonb,'[]','{}',$3,$3)`,[plan.id,JSON.stringify([older]),date]);
    }
    const hydrated = await hydrateHistoricalDispatchPlanOrders(plan);
    assert.deepEqual(hydrated.plan.orders.find(order => order.id === original.id),original);
    assert.equal(hydrated.reconstructed[0].sourceId,String(history.id));
  });
});

test("unapplied recovery drafts never override accepted historical cargo",async () => {
  await board(async (plan,original,history) => {
    const rejected = {...original,pallets: 100,items: [{itemId: 1,pallets: 100,quantity: 100}]};
    await query(`INSERT INTO dispatch_plan_snapshot_history(plan_id,plan_date,revision,orders,trucks,summary,
      original_saved_at,archived_at,archive_reason,checkpoint_kind)
      VALUES($1,'1910-01-01',1,$2::jsonb,'[]','{"saveRecovery":{"applied":false}}',
        '2026-09-15T13:00:00Z','2026-09-15T13:00:00Z','save_recovery','recovery')`,[plan.id,JSON.stringify([rejected])]);
    const hydrated = await hydrateHistoricalDispatchPlanOrders(plan);
    assert.deepEqual(hydrated.plan.orders.find(order => order.id === original.id),original);
    assert.equal(hydrated.reconstructed[0].sourceId,String(history.id));
    await query("DELETE FROM dispatch_plan_snapshot_history WHERE id=$1",[history.id]);
    await assert.rejects(hydrateHistoricalDispatchPlanOrders(plan),error => error.code === "DISPATCH_HISTORY_ORDER_SNAPSHOT_MISSING");
  });
});

test("an unchanged historical save repairs the missing card without changing its retained cargo",async () => {
  await board(async (plan,original) => {
    await applyDispatchV2Command({planId: plan.id,command: {commandId: crypto.randomUUID(),commandType: "replace_plan",
      baseRevision: 1,compactReceipt: true,payload: {orders: plan.orders,trucks: plan.trucks,summary: plan.summary}}});
    const stored = (await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1",[plan.id])).rows[0];
    assert.deepEqual(stored.orders.find(order => order.id === original.id),original);
    assert.equal(stored.trucks[0].loads[0].stops[1].orderId,original.id);
  });
});

test("future source evidence cannot supply an earlier historical order's cargo",async () => {
  await board(async plan => {
    await assert.rejects(hydrateHistoricalDispatchPlanOrders(plan),error => error.code === "DISPATCH_HISTORY_ORDER_SNAPSHOT_MISSING");
  },{evidenceAt: "2026-09-16T12:00:00Z"});
});

test("a dated Dispatch drop audit can recover a missing card only for this board's exact route stop",async () => {
  await board(async (plan,original) => {
    await query("DELETE FROM dispatch_plan_snapshot_history WHERE plan_id=$1",[plan.id]);
    const load = plan.trucks[0].loads[0];
    const audit = (await query(`INSERT INTO dispatch_audit_log(action,order_id,details,after_state,created_at)
      VALUES('order_dropped_to_load',$1,$2::jsonb,$3::jsonb,'2026-09-14') RETURNING id`,
    [original.id,JSON.stringify({order: original}),JSON.stringify(load)])).rows[0];
    const hydrated = await hydrateHistoricalDispatchPlanOrders(plan);
    assert.deepEqual(hydrated.plan.orders.find(order => order.id === original.id),original);
    assert.equal(hydrated.reconstructed[0].stream,"dispatch_drop_audit");
    assert.equal(hydrated.reconstructed[0].sourceId,String(audit.id));
    await query("UPDATE dispatch_audit_log SET created_at='2026-09-16' WHERE id=$1",[audit.id]);
    await assert.rejects(hydrateHistoricalDispatchPlanOrders(plan),error => error.code === "DISPATCH_HISTORY_ORDER_SNAPSHOT_MISSING");
    await query("UPDATE dispatch_audit_log SET created_at='2026-09-14',after_state=jsonb_set(after_state,'{stops,1,id}','\"unrelated-stop\"') WHERE id=$1",[audit.id]);
    await assert.rejects(hydrateHistoricalDispatchPlanOrders(plan),error => error.code === "DISPATCH_HISTORY_ORDER_SNAPSHOT_MISSING");
  });
});

test("legacy CO cards use only a manifest belonging to this plan that predates the board",async () => {
  await board(async plan => {
    const coRef = `CO-HISTORY-${plan.id}`;
    const co = (await query(`INSERT INTO local_co_orders(co_ref,source_order_ref,from_location_id,from_location,to_location_id,to_location,
      status,dispatch_plan_id,dispatch_plan_date,created_at,updated_at)
      VALUES($1,'SO-SOURCE',1,'3445',15,'12441','planned',$2,'1910-01-01','2026-09-14','2026-09-14') RETURNING id`,[coRef,plan.id])).rows[0];
    await query(`INSERT INTO local_co_order_lines(co_id,line_id,item_id,item_name,sku,quantity,pallet_qty)
      VALUES($1,1,1,'Retained CO manifest','CO-ITEM',25,5)`,[co.id]);
    const retained = {...plan,orders: [],trucks: structuredClone(plan.trucks)};
    retained.trucks[0].loads[0].stops[0].orderRefs = [coRef];
    retained.trucks[0].loads[0].stops[1].orderId = coRef;
    const hydrated = await hydrateHistoricalDispatchPlanOrders(retained);
    assert.equal(hydrated.plan.orders[0].id,coRef);
    assert.equal(hydrated.plan.orders[0].pallets,5);
    assert.equal(hydrated.plan.orders[0].items[0].quantity,25);
    assert.equal(hydrated.reconstructed[0].stream,"local_co_manifest");
    await query("UPDATE local_co_orders SET updated_at='2026-09-16' WHERE id=$1",[co.id]);
    await assert.rejects(hydrateHistoricalDispatchPlanOrders(retained),error => error.code === "DISPATCH_HISTORY_ORDER_SNAPSHOT_MISSING");
  });
});

test("a legacy whole-group CO retains its source group's full cargo and transit pickup",async () => {
  await board(async plan => {
    const groupRef = `GO-HISTORY-${plan.id}`;
    const coRef = `CO-${groupRef}`;
    const details = {sourceOrderId: groupRef,sourceOrderType: "SO",childOrderIds: ["SO-A","SO-B"],childOrderDetails: []};
    const co = (await query(`INSERT INTO local_co_orders(co_ref,source_order_ref,from_location_id,from_location,to_location_id,to_location,
      status,dispatch_plan_id,dispatch_plan_date,created_at,updated_at,details)
      VALUES($1,$2,1,'3445',15,'12441','planned',$3,'1910-01-01','2026-09-14','2026-09-14',$4::jsonb) RETURNING id`,
    [coRef,groupRef,plan.id,JSON.stringify(details)])).rows[0];
    await query(`INSERT INTO local_co_order_lines(co_id,line_id,item_id,item_name,sku,quantity,pallet_qty)
      VALUES($1,1,1,'Whole original manifest','GROUP-ITEM',25,5)`,[co.id]);
    const retained = {...plan,orders: [],trucks: structuredClone(plan.trucks)};
    retained.trucks[0].loads[0].stops[0].orderRefs = [groupRef];
    retained.trucks[0].loads[0].stops[0].location = "12441";
    retained.trucks[0].loads[0].stops[1].orderId = groupRef;
    retained.trucks[0].loads[0].stops[1].dropAddress = "Original Customer Street";
    const hydrated = await hydrateHistoricalDispatchPlanOrders(retained);
    assert.equal(hydrated.plan.orders[0].id,groupRef);
    assert.equal(hydrated.plan.orders[0].type,"SO");
    assert.equal(hydrated.plan.orders[0].pallets,5);
    assert.equal(hydrated.plan.orders[0].items[0].quantity,25);
    assert.equal(hydrated.plan.orders[0].address,"Original Customer Street");
    assert.deepEqual(hydrated.plan.orders[0].pickupLocations,["12441"]);
    assert.equal(hydrated.reconstructed[0].stream,"local_co_source_manifest");
    await query("UPDATE local_co_orders SET details=jsonb_set(details,'{childOrderDetails}','[{\"id\":\"SO-A\"}]') WHERE id=$1",[co.id]);
    await assert.rejects(hydrateHistoricalDispatchPlanOrders(retained),error => error.code === "DISPATCH_HISTORY_ORDER_SNAPSHOT_MISSING");
  });
});
