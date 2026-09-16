import assert from "node:assert/strict";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pool, query, closeDb } from "../../../src/db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { createDispatchPlan, saveDispatchPlanSnapshot, getDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { seedSalesOrder } from "../support/fulfilled-so-fixture.js";

after(closeDb);
test("a save waiting behind Driver completion rechecks after the Driver transaction commits", async () => {
  const ref = "SO-FULFILLED-RACE";
  await seedSalesOrder(817156001, ref);
  const plan = await createDispatchPlan({ planDate: "2096-11-01" });
  const driver = await pool.connect();
  let saving;
  try {
    await driver.query("BEGIN");
    await driver.query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    await driver.query(`INSERT INTO driver_job_records (job_id,driver_login,stop_type,order_refs,status,started_at,completed_at)
      VALUES ('fulfilled-race-job','fulfilled-race-driver','dropoff',$1::jsonb,'complete',now(),now())`, [JSON.stringify([ref])]);
    saving = saveDispatchPlanSnapshot(plan.id, {
      orders: [{ id: ref, type: "SO", dispatchFulfilledSalesPlanningEligible: true }],
      trucks: [{ id: "race-truck", loads: [{ id: "race-load", stops: [{ id: "race-drop", type: "drop", orderId: ref }] }] }],
      baseRevision: plan.revision
    }).then(value => ({ value }), error => ({ error }));
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = (await query("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted=false) AS waiting")).rows[0].waiting;
      if (waiting) break;
      await delay(10);
    }
    assert.equal(waiting, true, "The save must wait for the in-flight Driver transaction");
    await driver.query("COMMIT");
    const result = await saving;
    assert.equal(result.error?.code, "DISPATCH_ORDER_DRIVER_COMPLETED");
    assert.deepEqual((await getDispatchPlan(plan.id)).orders, []);
    assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_order_completion_events WHERE order_ref=$1", [ref])).rows[0].count, 1);
  } finally {
    await driver.query("ROLLBACK");
    driver.release();
    await saving;
  }
});
