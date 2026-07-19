import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  createDispatchPlan,
  restoreDispatchPlanSnapshot,
  saveDispatchPlanSnapshot
} from "./dispatch-plan-repository.js";
import { listDispatchPlanLoadAssignments } from "./dispatch-load-assignment-repository.js";

const rollback = await beginRollbackContext();

function testTruck(driverLogin, plate) {
  return [{
    id: `HARNESS-${plate}`,
    plate,
    base: "12441",
    driverLogin,
    driver: driverLogin,
    loads: [{
      id: "HARNESS-LOAD-1",
      name: "Load 1",
      returnOnly: true,
      returnYard: "12441",
      driverLogin,
      driverName: driverLogin,
      truckId: `HARNESS-${plate}`,
      truckPlate: plate,
      switchYard: "12441",
      parkingSpot: "H1",
      plannedStartMinute: 420,
      plannedFinishMinute: 480,
      driverSequence: 0,
      stops: []
    }]
  }];
}

try {
  await rollback.run(async () => {
    const planDate = `2088-${String((Date.now() % 11) + 1).padStart(2, "0")}-${String((Date.now() % 27) + 1).padStart(2, "0")}`;
    const plan = await createDispatchPlan({ planDate, note: "driver assignment integration harness" });
    const savedA = await saveDispatchPlanSnapshot(plan.id, {
      orders: [],
      trucks: testTruck("driver-a", "TEST-A"),
      planDate,
      baseRevision: plan.revision,
      sessionId: "driver-assignment-harness"
    });
    let rows = await listDispatchPlanLoadAssignments({ planId: plan.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].driver_login, "driver-a");
    assert.equal(rows[0].truck_plate, "TEST-A");

    await saveDispatchPlanSnapshot(plan.id, {
      orders: [],
      trucks: testTruck("driver-b", "TEST-B"),
      planDate,
      baseRevision: savedA.revision,
      sessionId: "driver-assignment-harness"
    });
    rows = await listDispatchPlanLoadAssignments({ planId: plan.id });
    assert.equal(rows[0].driver_login, "driver-b");
    assert.equal(rows[0].truck_plate, "TEST-B");

    const history = await query(
      `SELECT id
         FROM dispatch_plan_snapshot_history
        WHERE plan_id = $1
          AND trucks::text LIKE '%driver-a%'
        ORDER BY id DESC
        LIMIT 1`,
      [plan.id]
    );
    assert.equal(history.rowCount, 1);
    await restoreDispatchPlanSnapshot(history.rows[0].id, { sessionId: "driver-assignment-harness" });
    rows = await listDispatchPlanLoadAssignments({ planId: plan.id });
    assert.equal(rows[0].driver_login, "driver-a");
    assert.equal(rows[0].truck_plate, "TEST-A");
  });
  console.log(JSON.stringify({ ok: true, tests: 8 }));
} finally {
  await rollback.rollback();
  await closeDb();
}
