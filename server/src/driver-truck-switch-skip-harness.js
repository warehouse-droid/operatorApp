import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import { skipDriverTruckSwitchSamsara } from "./driver-repository.js";

const suffix = String(Date.now()).slice(-8);
const driverLogin = `switch-skip-${suffix}`;
const jobId = `switch-skip-job-${suffix}`;
const planDate = "2098-07-17";
const job = {
  jobId,
  planId: null,
  planDate,
  driverLogin,
  fromTruckId: "TRUCK-A",
  fromTruckPlate: "TEST-A",
  nextTruckId: "TRUCK-B",
  nextTruckPlate: "TEST-B",
  truckId: "TRUCK-B",
  truckPlate: "TEST-B",
  switchYard: "12441",
  parkingSpot: "P2",
  loadId: "LOAD-2",
  plannedSwitchMinute: 600,
  stopType: "truck_switch"
};

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    const result = await skipDriverTruckSwitchSamsara(jobId, driverLogin, { job });
    assert.equal(result.switchRecord.status, "skipped");
    assert.equal(result.switchRecord.driver_login, driverLogin);
    assert.equal(result.switchRecord.to_truck_plate, "TEST-B");

    const switchRow = await query(
      `SELECT status, overridden_by, override_reason, samsara_error
         FROM driver_truck_switch_records
        WHERE job_id = $1`,
      [jobId]
    );
    assert.equal(switchRow.rows[0]?.status, "skipped");
    assert.equal(switchRow.rows[0]?.overridden_by, driverLogin);
    assert.match(switchRow.rows[0]?.override_reason || "", /skipped Samsara/i);
    assert.equal(switchRow.rows[0]?.samsara_error, "");

    const completedJob = await query(
      `SELECT status, stop_type, truck_plate
         FROM driver_job_records
        WHERE job_id = $1`,
      [jobId]
    );
    assert.equal(completedJob.rows[0]?.status, "complete");
    assert.equal(completedJob.rows[0]?.stop_type, "truck_switch");
    assert.equal(completedJob.rows[0]?.truck_plate, "TEST-B");

    await assert.rejects(
      () => skipDriverTruckSwitchSamsara(jobId, driverLogin, { job }),
      /can no longer be skipped/i
    );
  });
  console.log("Driver pre-failure Samsara skip rollback harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
