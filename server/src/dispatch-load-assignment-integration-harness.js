import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  createDispatchPlan,
  restoreDispatchPlanSnapshot,
  saveDispatchPlanSnapshot
} from "./dispatch-plan-repository.js";
import { listDispatchPlanLoadAssignments, syncDispatchPlanLoadAssignments } from "./dispatch-load-assignment-repository.js";
import { planJobsForDriver } from "./driver-repository.js";

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

function executionTruck(driverLogin, plate, orderRef) {
  return [{
    id: `HARNESS-${plate}`,
    plate,
    base: "12441",
    driverLogin,
    driver: driverLogin,
    loads: [{
      id: "HARNESS-EXECUTION-LOAD",
      name: "Execution Load",
      driverLogin,
      driverName: driverLogin,
      truckId: `HARNESS-${plate}`,
      truckPlate: plate,
      switchYard: "12441",
      parkingSpot: "H2",
      plannedStartMinute: 420,
      plannedFinishMinute: 540,
      driverSequence: 0,
      stops: [
        { id: "HARNESS-PICKUP", type: "pick", orderId: orderRef, location: "12441" },
        { id: "HARNESS-DROPOFF", type: "drop", orderId: orderRef, location: "Customer" }
      ]
    }]
  }];
}

async function completeDriverJob(job) {
  await query(
    `INSERT INTO driver_job_records (
       job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
       load_id, load_name, stop_id, stop_type, order_refs, photo_data_urls,
       status, started_at, completed_at, job_details
     ) VALUES (
       $1, $2, $3::date, $4, $5, $6,
       $7, $8, $9, $10, $11::jsonb, '[]'::jsonb,
       'complete', now(), now(), '{}'::jsonb
     )`,
    [
      job.jobId,
      job.planId,
      job.planDate,
      job.driverLogin,
      job.truckId,
      job.truckPlate,
      job.loadId,
      job.loadName,
      job.stopId,
      job.stopType,
      JSON.stringify(job.orderRefs || [])
    ]
  );
}

try {
  await rollback.run(async () => {
    for (const login of ["driver-a", "driver-b", "driver-execution"]) {
      await query("UPDATE dispatch_drivers SET active = true WHERE lower(btrim(login)) = $1", [login]);
      await query(
        `INSERT INTO dispatch_drivers (name, login, active)
         SELECT $1, $1, true
          WHERE NOT EXISTS (SELECT 1 FROM dispatch_drivers WHERE lower(btrim(login)) = $1)`,
        [login]
      );
    }
    for (const plate of ["TEST-A", "TEST-B", "TEST-EXECUTION"]) {
      await query("UPDATE dispatch_trucks SET active = true WHERE upper(btrim(plate)) = $1", [plate]);
      await query(
        `INSERT INTO dispatch_trucks (plate, active)
         SELECT $1, true
          WHERE NOT EXISTS (SELECT 1 FROM dispatch_trucks WHERE upper(btrim(plate)) = $1)`,
        [plate]
      );
    }
    const planDate = `2088-${String((Date.now() % 11) + 1).padStart(2, "0")}-${String((Date.now() % 27) + 1).padStart(2, "0")}`;
    const plan = await createDispatchPlan({ planDate, note: "driver assignment integration harness" });
    const savedA = await saveDispatchPlanSnapshot(plan.id, {
      orders: [],
      trucks: testTruck("driver-a", "TEST-A"),
      summary: { ownYardCodes: ["CUSTOM-YARD"] },
      planDate,
      baseRevision: plan.revision,
      sessionId: "driver-assignment-harness"
    });
    let rows = await listDispatchPlanLoadAssignments({ planId: plan.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].driver_login, "driver-a");
    assert.equal(rows[0].truck_plate, "TEST-A");
    assert.equal(savedA.summary.dispatchPlanFormat.version, 2);
    assert.equal(savedA.summary.dispatchPlanFormat.source, "dispatchV2-save");
    assert.deepEqual(savedA.summary.ownYardCodes, ["CUSTOM-YARD"]);

    const savedB = await saveDispatchPlanSnapshot(plan.id, {
      orders: [],
      trucks: testTruck("driver-b", "TEST-B"),
      planDate,
      baseRevision: savedA.revision,
      sessionId: "driver-assignment-harness"
    });
    rows = await listDispatchPlanLoadAssignments({ planId: plan.id });
    assert.equal(rows[0].driver_login, "driver-b");
    assert.equal(rows[0].truck_plate, "TEST-B");
    assert.equal(savedB.summary.dispatchPlanFormat.migratedAt, savedA.summary.dispatchPlanFormat.migratedAt);
    assert.deepEqual(savedB.summary.ownYardCodes, ["CUSTOM-YARD"]);

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
    const restored = await restoreDispatchPlanSnapshot(history.rows[0].id, { sessionId: "driver-assignment-harness" });
    rows = await listDispatchPlanLoadAssignments({ planId: plan.id });
    assert.equal(rows[0].driver_login, "driver-a");
    assert.equal(rows[0].truck_plate, "TEST-A");
    assert.equal(restored.plan.summary.dispatchPlanFormat.source, "dispatchV2-save");
    assert.deepEqual(restored.plan.summary.ownYardCodes, ["CUSTOM-YARD"]);

    const executionPlanDate = `2089-${String((Date.now() % 11) + 1).padStart(2, "0")}-${String((Date.now() % 27) + 1).padStart(2, "0")}`;
    const executionOrderRef = "HARNESS-SO-EXECUTION";
    const executionPlan = await createDispatchPlan({ planDate: executionPlanDate, note: "load completion projection harness" });
    const savedExecutionPlan = await saveDispatchPlanSnapshot(executionPlan.id, {
      orders: [{ id: executionOrderRef, type: "SO", sourceYard: "12441", address: "Customer" }],
      trucks: executionTruck("driver-execution", "TEST-EXECUTION", executionOrderRef),
      planDate: executionPlanDate,
      baseRevision: executionPlan.revision,
      sessionId: "driver-assignment-completion-harness"
    });
    const expectedJobs = planJobsForDriver(savedExecutionPlan, "driver-execution")
      .filter((job) => job.loadId === "HARNESS-EXECUTION-LOAD");
    assert.equal(expectedJobs.length, 2);
    assert.equal(expectedJobs[0].stopType, "pickup");
    assert.equal(expectedJobs[1].stopType, "dropoff");

    await completeDriverJob(expectedJobs[0]);
    await syncDispatchPlanLoadAssignments(savedExecutionPlan);
    rows = await listDispatchPlanLoadAssignments({ planId: executionPlan.id });
    assert.equal(rows[0].started, true);
    assert.equal(rows[0].completed, false);

    await completeDriverJob(expectedJobs[1]);
    await syncDispatchPlanLoadAssignments(savedExecutionPlan);
    rows = await listDispatchPlanLoadAssignments({ planId: executionPlan.id });
    assert.equal(rows[0].started, true);
    assert.equal(rows[0].completed, true);
  });
  console.log(JSON.stringify({ ok: true, tests: 23 }));
} finally {
  await rollback.rollback();
  await closeDb();
}
