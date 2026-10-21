import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query,withTransaction,closeDb } from "../../../src/db.js";
import { hydrateHistoricalDispatchPlanOrders } from "../../../src/dispatch-historical-order-snapshots.js";
import { retainsHistoricalDispatchBoard } from "../../../src/dispatch-history-mode.js";
import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";
import { dispatchRequiredPickupVisitLocations } from "../../../src/dispatch-pickup-visits.js";

after(closeDb);

function historicalPlan(pallets, pieces) {
  return {planDate: "1910-01-01",orders: [{id: "SO-HISTORY",type: "SO",pallets,pieces,
    pickupLocations: ["3445"],items: []}],summary: {},trucks: [{id: "truck",plate: "HISTORY",
    driverLogin: "driver",loads: [{id: "load",stops: [
      {id: "old-pick",type: "pick",location: "3445"},
      {id: "old-drop",type: "drop",orderId: "SO-HISTORY",dropAddress: "100 History Street"}]}]}]};
}

test("historical preservation requires an exact board and excludes structure side effects",() => {
  fc.assert(fc.property(fc.integer({min: 0,max: 100}),fc.integer({min: 0,max: 1000}), (pallets,pieces) => {
    const plan = historicalPlan(pallets,pieces);
    const command = {commandType: "replace_plan",payload: structuredClone(plan)};
    assert.equal(retainsHistoricalDispatchBoard(plan,command),true);
    const future = {...structuredClone(plan),planDate: "9999-01-01"};
    assert.equal(retainsHistoricalDispatchBoard(future,{...command,payload: future}),false);
    command.payload.orders[0].pallets++;
    assert.equal(retainsHistoricalDispatchBoard(plan,command),false);
    command.payload = {...structuredClone(plan),retiredGlobalOrderRefs: ["SO-HISTORY"]};
    assert.equal(retainsHistoricalDispatchBoard(plan,command),false);
    command.payload = {...structuredClone(plan),summary: {driverOriented: true}};
    assert.equal(retainsHistoricalDispatchBoard(plan,command),false);
  }),{numRuns: 1000,seed: 20261002});
});

test("unknown historical stop IDs preserve identical boards and reject changed cargo",() => {
  fc.assert(fc.property(fc.integer({min: 1,max: 100}),fc.integer({min: 0,max: 1000}), (pallets,pieces) => {
    const plan = historicalPlan(pallets,pieces);
    const activity = [{status: "complete",stop_type: "dropoff",load_id: "load",
      stop_id: "later-drop",order_refs: ["SO-HISTORY"]}];
    const next = structuredClone(plan);
    assert.equal(evaluateExecutedPrefixPolicy({previousPlan: plan,nextPlan: next,activity}).allowed,true);
    next.orders[0].pallets++;
    assert.equal(evaluateExecutedPrefixPolicy({previousPlan: plan,nextPlan: next,activity}).allowed,false);
  }),{numRuns: 1000,seed: 20261003});
});

test("grouped orders retain every child's nonempty effective pickup while whole-group COs own their manifest",() => {
  fc.assert(fc.property(fc.uniqueArray(fc.constantFrom("3445","12441","2967","150"),{minLength: 2,maxLength: 4}),locations => {
    const children = locations.map((location,index) => ({id: `SO-${index}`,type: "SO",sourceYard: location,
      pickupLocations: [location],items: [{itemId: index+1,pallets: 1,quantity: 1}]}));
    const group = {id: "GO-PROPERTY",type: "SO",sourceYard: locations[0],pickupLocations: [locations[0]],items: [],
      childOrders: children.map(child => child.id),childOrderDetails: children};
    assert.deepEqual(dispatchRequiredPickupVisitLocations(group,{}).sort(),[...locations].sort());
    const wholeGroup = {...group,sourceYard: "Vendor",pickupLocations: ["Vendor"],items: [{itemId: 99,pallets: 1,quantity: 1}],
      directPickupManifest: [{location: "Vendor",items: [{itemId: 99,palletQty: 1,quantity: 1}]}],
      transitCo: {id: "CO-GROUP",toYard: "Vendor"}};
    assert.deepEqual(dispatchRequiredPickupVisitLocations(wholeGroup,{}),["Vendor"]);
  }),{numRuns: 1000,seed: 20261004});
});

test("historical cargo comes from the newest accepted preceding card, excluding failed edits and future cargo",async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 0,max: 50}),fc.integer({min: 1,max: 50}),async (olderPallets,newerPallets) => {
    await withTransaction(async () => {
      const header = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('1910-01-01','draft') RETURNING id")).rows[0];
      const id = `SO-TEMPORAL-${header.id}`;
      const card = pallets => ({id,type: "SO",pallets,items: [{itemId: 1,pallets,quantity: pallets}]});
      const accepted = [];
      for (const [date,pallets,recovery] of [
        ["2026-07-30",olderPallets,false],["2026-08-30",olderPallets+1,false],
        ["2026-09-13",newerPallets,false],["2026-09-14",newerPallets+10,true],["2026-09-16",newerPallets+20,false]
      ]) {
        const row = (await query(`INSERT INTO dispatch_plan_snapshot_history(plan_id,plan_date,revision,orders,trucks,summary,
          original_saved_at,archived_at,archive_reason,checkpoint_kind)
          VALUES($1,'1910-01-01',0,$2::jsonb,'[]',$3::jsonb,$4,$4,$5,$6) RETURNING id`,
        [header.id,JSON.stringify([card(pallets)]),JSON.stringify(recovery ? {saveRecovery: {applied: false}} : {}),date,
          recovery ? "save_recovery" : "before_save",recovery ? "recovery" : "legacy"])).rows[0];
        if (!recovery && date < "2026-09-15") { accepted.push(row.id); }
      }
      const plan = {id: String(header.id),planDate: "1910-01-01",savedAt: "2026-09-15T15:00:00Z",orders: [],
        trucks: [{loads: [{stops: [{type: "drop",orderId: id}]}]}]};
      const hydrated = await hydrateHistoricalDispatchPlanOrders(plan);
      assert.deepEqual(hydrated.plan.orders,[card(newerPallets)]);
      await query("DELETE FROM dispatch_plan_snapshot_history WHERE id=ANY($1::bigint[])",[accepted]);
      await assert.rejects(hydrateHistoricalDispatchPlanOrders(plan),error => error.code === "DISPATCH_HISTORY_ORDER_SNAPSHOT_MISSING");
    },{rollback: true});
  }),{numRuns: 80,seed: 20261005});
});
