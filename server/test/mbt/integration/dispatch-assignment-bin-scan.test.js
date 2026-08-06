import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  listDispatchPlanLoadAssignments,
  syncDispatchPlanLoadAssignments
} from "../../../src/dispatch-load-assignment-repository.js";
import { planJobsForDriver } from "../../../src/driver-repository.js";

const PLAN_DATE = "2097-08-03";

function returnTruck({ driverLogin, loadId, plate, startMinute }) {
  return {
    id: `TRUCK-${plate}`,
    plate,
    base: "3445",
    driverLogin,
    driver: driverLogin,
    loads: [{
      id: loadId,
      name: loadId,
      returnOnly: true,
      returnYard: "12441",
      driverLogin,
      driverName: driverLogin,
      truckId: `TRUCK-${plate}`,
      truckPlate: plate,
      switchYard: "3445",
      parkingSpot: "TEST",
      plannedStartMinute: startMinute,
      plannedFinishMinute: startMinute + 30,
      driverSequence: 0,
      stops: []
    }]
  };
}

async function recordCompletedJob(job) {
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

after(closeDb);

test("F14 non-regression: multi-driver assignment sync inspects BIN identity once and preserves ordinary projections", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const created = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ($1::date, 'draft', 'single BIN inspection regression', 1)
         RETURNING id`,
        [PLAN_DATE]
      );
      const planId = String(created.rows[0].id);
      let binInspectionCount = 0;
      const ordinaryProbeOrder = {
        id: "SO-BIN-SCAN-PROBE",
        type: "SO",
        childOrderDetails: []
      };
      Object.defineProperty(ordinaryProbeOrder, "mbt", {
        configurable: false,
        enumerable: true,
        get() {
          binInspectionCount += 1;
          return [];
        }
      });
      const plan = {
        id: planId,
        planDate: PLAN_DATE,
        orders: [ordinaryProbeOrder],
        trucks: [
          returnTruck({
            driverLogin: "bin-scan-driver-a",
            loadId: "BIN-SCAN-LOAD-A",
            plate: "BIN-SCAN-A",
            startMinute: 420
          }),
          returnTruck({
            driverLogin: "bin-scan-driver-b",
            loadId: "BIN-SCAN-LOAD-B",
            plate: "BIN-SCAN-B",
            startMinute: 480
          })
        ]
      };

      const driverAJobs = planJobsForDriver(plan, "bin-scan-driver-a");
      const driverBJobs = planJobsForDriver(plan, "bin-scan-driver-b");
      assert.equal(driverAJobs.length, 1);
      assert.equal(driverBJobs.length, 1);
      await recordCompletedJob(driverAJobs[0]);
      binInspectionCount = 0;

      await syncDispatchPlanLoadAssignments(plan);

      assert.equal(
        binInspectionCount,
        1,
        "one plan synchronization must not repeat the complete BIN scan for every assigned driver"
      );
      const rows = await listDispatchPlanLoadAssignments({ planId });
      assert.deepEqual(
        rows.map((row) => ({
          loadId: row.load_id,
          driverLogin: row.driver_login,
          truckPlate: row.truck_plate,
          started: row.started,
          completed: row.completed
        })),
        [
          {
            loadId: driverAJobs[0].loadId,
            driverLogin: driverAJobs[0].driverLogin,
            truckPlate: driverAJobs[0].truckPlate,
            started: true,
            completed: true
          },
          {
            loadId: driverBJobs[0].loadId,
            driverLogin: driverBJobs[0].driverLogin,
            truckPlate: driverBJobs[0].truckPlate,
            started: false,
            completed: false
          }
        ]
      );
    });
  } finally {
    await rollback.rollback();
  }
});
