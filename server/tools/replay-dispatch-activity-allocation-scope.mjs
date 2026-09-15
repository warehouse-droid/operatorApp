import assert from "node:assert/strict";
import { query, withTransaction, closeDb } from "../src/db.js";
import { getDispatchPlan } from "../src/dispatch-plan-repository.js";
import { evaluateExecutedPrefixPolicy } from "../src/dispatch-planner-performance.js";
import { overlayLockedLoadDerivedSchedule } from "../src/dispatch-load-assignment.js";

// Read only the exact incident, in memory. Never export its operational data.
try {
  await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await query("SET LOCAL statement_timeout = '30s'");
    const fixture = {
      previousPlan: { id: "326", ...(await query("SELECT orders,trucks,summary FROM dispatch_plan_snapshots WHERE plan_id=326")).rows[0] },
      draft: { id: "326", ...(await query("SELECT orders,trucks,summary FROM dispatch_plan_snapshot_history WHERE id=17308 AND plan_id=326")).rows[0] },
      refreshed: await getDispatchPlan("326"),
      activity: (await query("SELECT status,load_id,stop_id,stop_type,order_refs,job_details FROM driver_job_records WHERE plan_id=326 AND status IN ('in_progress','complete') ORDER BY id")).rows
    };
    assert.equal(fixture.previousPlan.id, "326");
    const before = structuredClone(fixture);
    const nextPlan = overlayLockedLoadDerivedSchedule(fixture.refreshed, fixture.draft, new Set(), {
      activityStatuses: fixture.activity
    });
    const policy = evaluateExecutedPrefixPolicy({ previousPlan: fixture.previousPlan, nextPlan, activity: fixture.activity });
    assert.deepEqual(policy, { allowed: true, conflicts: [] });
    const loads = plan => plan.trucks.flatMap(truck => truck.loads || []);
    const protectedIds = new Set(fixture.activity.map(record => record.load_id));
    for (const id of protectedIds) {
      assert.deepEqual(loads(nextPlan).find(load => load.id === id), loads(fixture.previousPlan).find(load => load.id === id));
    }
    assert.equal(nextPlan.orders.some(order => order.id === "CO-GOA-8111-8113"), false);
    const coLoad = loads(nextPlan).find(load => load.stops?.some(stop => stop.orderId === "CO-SOM06255-S1"));
    assert.equal(coLoad?.name, "Load 5");
    assert.equal(coLoad?.stops.at(-1).orderId, "CO-SOM06255-S1");
    const bad = structuredClone(nextPlan);
    bad.orders.find(order => order.id === "GOA-8111-8113").childOrderDetails[0].items[0].quantity += 1;
    assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: fixture.previousPlan, nextPlan: bad, activity: fixture.activity }).allowed, false);
    assert.deepEqual(fixture, before);
    console.log(JSON.stringify({ check: "incident_17308", allowed: true, laterCo: "CO-SOM06255-S1",
      executedLoadsUnchanged: protectedIds.size, realCargoEditRejected: true, inputUnchanged: true,
      productionTransactionReadOnly: true }));
  });
} finally {
  await closeDb();
}
