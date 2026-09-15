import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { getDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { assertDispatchExecutedPrefixPreserved } from "../../../src/dispatch-executed-prefix-repository.js";

after(closeDb);

async function scenario(run, offset = 0) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const row = (await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES ('2097-09-14','draft',1) RETURNING id")).rows[0];
      const orders = [
        { id: "SO-RETIRED-TIMING-A", type: "SO", sourceYard: "3445", pickupLocations: ["3445"], address: "Timing A", items: [{ itemId: 817140900, quantity: 4 }], poPickupManifest: [{ location: "3445", poOrderRef: "PO-OBSOLETE-PROJECTION" }] },
        { id: "SO-RETIRED-TIMING-B", type: "SO", sourceYard: "2967", pickupLocations: ["2967"], address: "Timing B", items: [{ itemId: 817140901, quantity: 2 }] }
      ];
      const stop = (id, type, order, location, arrival) => ({ id, type, orderId: order.id, location,
        timing: { arrival: arrival + offset, depart: arrival + offset + 10 } });
      const trucks = [{ id: "", plate: "", loads: [{ id: "timing-load", name: "Timing load", routeEstimate: { stale: true },
        stops: [stop("pick-a", "pick", orders[0], "3445", 450), stop("drop-a", "drop", orders[0], "Timing A", 480),
          stop("pick-b", "pick", orders[1], "2967", 520), stop("drop-b", "drop", orders[1], "Timing B", 560)] }] }];
      const plan = { id: String(row.id), planDate: "2097-09-14", orders, trucks, revision: 1 };
      await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,'{}')", [plan.id, JSON.stringify(orders), JSON.stringify(trucks)]);
      await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,
        load_id,load_name,stop_id,stop_type,order_refs,status,started_at,completed_at)
        VALUES($1,$2,'2097-09-14','timing-regression','','','timing-load','Timing load','drop-a','drop',$3::jsonb,'complete',now(),now())`,
      [`timing-regression-${plan.id}`, plan.id, JSON.stringify([orders[0].id])]);
      await run(plan);
    });
  } finally { await rollback.rollback(); }
}

test("plan projection refresh preserves recorded timing through the executed stop and invalidates only future timing", () => scenario(async previous => {
  const next = await getDispatchPlan(previous.id);
  assert.deepEqual(next.trucks[0].loads[0].stops.slice(0, 2).map(stop => stop.timing), previous.trucks[0].loads[0].stops.slice(0, 2).map(stop => stop.timing));
  assert.equal(next.trucks[0].loads[0].stops[3].timing, undefined);
  assert.equal(next.trucks[0].loads[0].routeEstimate, undefined);
  assert.equal((await assertDispatchExecutedPrefixPreserved({ previousPlan: previous, nextPlan: next })).allowed, true);
  assert.deepEqual((await query("SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [previous.id])).rows[0].trucks, previous.trucks);
}));

test("preserving timing still rejects changed executed stops and cargo while allowing later work", () => scenario(async previous => {
  const next = await getDispatchPlan(previous.id);
  const changed = structuredClone(next);
  changed.trucks[0].loads[0].stops[1].location = "Changed executed destination";
  await assert.rejects(assertDispatchExecutedPrefixPreserved({ previousPlan: previous, nextPlan: changed }), error => error.code === "DISPATCH_ACTIVE_LOAD_LOCKED");
  const cargo = structuredClone(next);
  cargo.orders[0].items[0].quantity += 1;
  await assert.rejects(assertDispatchExecutedPrefixPreserved({ previousPlan: previous, nextPlan: cargo }), error => error.code === "DISPATCH_ACTIVE_LOAD_LOCKED");
  next.trucks[0].loads[0].stops[3].location = "Changed future destination";
  assert.equal((await assertDispatchExecutedPrefixPreserved({ previousPlan: previous, nextPlan: next })).allowed, true);
}));

test("property: refresh retains exact historical timing over varying schedules without persisting the read", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 120 }), offset => scenario(async previous => {
    const next = await getDispatchPlan(previous.id);
    assert.deepEqual(next.trucks[0].loads[0].stops.slice(0, 2).map(stop => stop.timing), previous.trucks[0].loads[0].stops.slice(0, 2).map(stop => stop.timing));
    assert.equal(next.trucks[0].loads[0].stops[3].timing, undefined);
    assert.equal((await assertDispatchExecutedPrefixPreserved({ previousPlan: previous, nextPlan: next })).allowed, true);
  }, offset)), { seed: 20260914, numRuns: 20 });
});
