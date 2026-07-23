import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  ensureDispatchFleetSetup,
  getDispatchDriverByLogin,
  listDispatchDrivers,
  listDispatchTrucks,
  replaceDispatchFleetSetup,
  setDispatchDriverActive,
  setDispatchTruckActive
} from "./dispatch-setup-repository.js";
import { createDispatchPlan, saveDispatchPlanSnapshot } from "./dispatch-plan-repository.js";
import { syncDispatchPlanLoadAssignments } from "./dispatch-load-assignment-repository.js";
import { planJobsForDriver } from "./driver-repository.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const passwordFingerprints = async () => (await query(
  `SELECT id::text, md5(coalesce(password_hash, '') || ':' || coalesce(password_salt, '')) AS fingerprint
   FROM dispatch_drivers
   ORDER BY id`
)).rows;

const historyCounts = async () => (await query(
  `SELECT
     (SELECT count(*)::integer FROM driver_day_records) AS driver_days,
     (SELECT count(*)::integer FROM driver_job_records) AS driver_jobs,
     (SELECT count(*)::integer FROM dispatch_plan_snapshots) AS plan_snapshots,
     (SELECT count(*)::integer FROM dispatch_plan_snapshot_history) AS snapshot_history`
)).rows[0];

const rollbackContext = await beginRollbackContext();

try {
  const result = await rollbackContext.run(async () => {
    let drivers = await listDispatchDrivers({ activeOnly: false });
    let trucks = await listDispatchTrucks({ activeOnly: false });
    if (!drivers.length || !trucks.length) {
      await replaceDispatchFleetSetup({
        drivers: drivers.length ? drivers : [{ name: "Fleet Harness Driver", login: "fleet-harness-driver", license: "AZ", number: "HARNESS", active: true }],
        trucks: trucks.length ? trucks : [{ plate: "FLEET-HARNESS", capacityLbs: 48000, active: true }]
      }, { activeOnly: false });
      drivers = await listDispatchDrivers({ activeOnly: false });
      trucks = await listDispatchTrucks({ activeOnly: false });
    }

    const targetDriver = drivers[0];
    const targetTruck = trucks[0];
    const passwordsBefore = await passwordFingerprints();
    const historyBefore = await historyCounts();

    const disabledDriver = await setDispatchDriverActive(targetDriver.id, false);
    const disabledTruck = await setDispatchTruckActive(targetTruck.id, false);
    assert(disabledDriver?.driver?.active === false, "Driver disable did not persist.");
    assert(disabledTruck?.truck?.active === false, "Truck disable did not persist.");
    assert(!(await listDispatchDrivers()).some((driver) => driver.id === targetDriver.id), "Disabled driver leaked into the active list.");
    assert(!(await listDispatchTrucks()).some((truck) => truck.id === targetTruck.id), "Disabled truck leaked into the active list.");
    assert((await listDispatchDrivers({ activeOnly: false })).find((driver) => driver.id === targetDriver.id)?.active === false, "Disabled driver is missing from setup management.");
    assert((await listDispatchTrucks({ activeOnly: false })).find((truck) => truck.id === targetTruck.id)?.active === false, "Disabled truck is missing from setup management.");
    assert(await getDispatchDriverByLogin(targetDriver.login) === null, "Disabled driver can still access driver execution.");

    drivers = (await listDispatchDrivers({ activeOnly: false })).map((driver) => ({
      ...driver,
      active: driver.id === targetDriver.id ? false : driver.active,
      login: driver.id === targetDriver.id ? `renamed-driver-${driver.id}` : driver.login
    }));
    trucks = (await listDispatchTrucks({ activeOnly: false })).map((truck) => ({
      ...truck,
      active: truck.id === targetTruck.id ? false : truck.active,
      plate: truck.id === targetTruck.id ? `RENAMED-${truck.id}` : truck.plate
    }));
    const saved = await replaceDispatchFleetSetup({ drivers, trucks }, { activeOnly: false });
    assert(saved.drivers.find((driver) => driver.id === targetDriver.id)?.active === false, "A normal setup save re-enabled the disabled driver.");
    assert(saved.trucks.find((truck) => truck.id === targetTruck.id)?.active === false, "A normal setup save re-enabled the disabled truck.");
    assert(saved.drivers.find((driver) => driver.id === targetDriver.id)?.login === targetDriver.login, "Existing driver login changed and broke stable plan identity.");
    assert(saved.trucks.find((truck) => truck.id === targetTruck.id)?.plate === targetTruck.plate, "Existing truck plate changed and broke stable plan identity.");
    assert(JSON.stringify(passwordsBefore) === JSON.stringify(await passwordFingerprints()), "Driver password hashes changed during a blank-password setup save.");

    const enabledDriver = await setDispatchDriverActive(targetDriver.id, true);
    const enabledTruck = await setDispatchTruckActive(targetTruck.id, true);
    assert(enabledDriver?.driver?.active === true, "Driver enable did not persist.");
    assert(enabledTruck?.truck?.active === true, "Truck enable did not persist.");
    assert((await listDispatchDrivers()).some((driver) => driver.id === targetDriver.id), "Enabled driver did not return to the active list.");
    assert((await listDispatchTrucks()).some((truck) => truck.id === targetTruck.id), "Enabled truck did not return to the active list.");
    assert(JSON.stringify(historyBefore) === JSON.stringify(await historyCounts()), "Fleet status changes modified historical plans or statistics records.");

    const planDate = `2197-12-${String((Date.now() % 27) + 1).padStart(2, "0")}`;
    const plan = await createDispatchPlan({ planDate, note: "fleet status validation harness" });
    const planPayload = {
      orders: [],
      trucks: [{
        id: targetTruck.id,
        plate: targetTruck.plate,
        base: targetTruck.baseYard || "150",
        driverLogin: targetDriver.login,
        loads: [{
          id: "FLEET-STATUS-LOAD",
          name: "Fleet status load",
          returnOnly: true,
          returnYard: "12441",
          driverLogin: targetDriver.login,
          truckId: targetTruck.id,
          truckPlate: targetTruck.plate,
          stops: []
        }]
      }],
      planDate,
      baseRevision: plan.revision,
      sessionId: "fleet-status-harness"
    };
    const savedPlan = await saveDispatchPlanSnapshot(plan.id, planPayload);
    await setDispatchDriverActive(targetDriver.id, false);
    let disabledPlanError = null;
    try {
      await saveDispatchPlanSnapshot(plan.id, { ...planPayload, baseRevision: savedPlan.revision });
    } catch (error) {
      disabledPlanError = error;
    }
    assert(disabledPlanError?.code === "DISPATCH_DRIVER_DISABLED", "Plan repository accepted a disabled driver assignment.");
    await setDispatchDriverActive(targetDriver.id, true);
    await setDispatchTruckActive(targetTruck.id, false);
    disabledPlanError = null;
    try {
      await saveDispatchPlanSnapshot(plan.id, { ...planPayload, baseRevision: savedPlan.revision });
    } catch (error) {
      disabledPlanError = error;
    }
    assert(disabledPlanError?.code === "DISPATCH_TRUCK_DISABLED", "Plan repository accepted a disabled truck assignment.");
    await setDispatchTruckActive(targetTruck.id, true);
    const completedJobs = planJobsForDriver(savedPlan, targetDriver.login);
    assert(completedJobs.length > 0, "Fleet completion fixture did not generate driver jobs.");
    for (const job of completedJobs) {
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
           load_id, load_name, stop_id, stop_type, status, completed_at
         ) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, 'complete', now())
         ON CONFLICT (job_id) DO UPDATE
           SET status = 'complete', completed_at = now()`,
        [
          job.jobId,
          savedPlan.id,
          savedPlan.planDate,
          targetDriver.login,
          targetTruck.id,
          targetTruck.plate,
          job.loadId || "FLEET-STATUS-LOAD",
          job.loadName || "Fleet status load",
          job.stopId || "RETURN",
          job.stopType || "return"
        ]
      );
    }
    await syncDispatchPlanLoadAssignments(savedPlan);
    const completedProjection = await query(
      `SELECT completed
         FROM dispatch_plan_load_assignments
        WHERE plan_id = $1 AND load_id = 'FLEET-STATUS-LOAD'`,
      [savedPlan.id]
    );
    assert(completedProjection.rows[0]?.completed === true, "Completed load projection was not established.");
    await setDispatchDriverActive(targetDriver.id, false);
    await setDispatchTruckActive(targetTruck.id, false);
    const preservedCompletedPlan = await saveDispatchPlanSnapshot(plan.id, {
      ...planPayload,
      baseRevision: savedPlan.revision,
      summary: { completionHistoryPreserved: true }
    });
    assert(preservedCompletedPlan.summary?.completionHistoryPreserved === true, "An unrelated edit was blocked after the assigned load was completed.");
    disabledPlanError = null;
    try {
      await saveDispatchPlanSnapshot(plan.id, {
        ...planPayload,
        baseRevision: preservedCompletedPlan.revision,
        trucks: planPayload.trucks.map((parentTruck) => ({
          ...parentTruck,
          loads: parentTruck.loads.map((load) => ({ ...load, orders: ["SO-NEW-WORK"] }))
        }))
      });
    } catch (error) {
      disabledPlanError = error;
    }
    assert(disabledPlanError?.code === "DISPATCH_DRIVER_DISABLED" || disabledPlanError?.code === "DISPATCH_TRUCK_DISABLED", "Completed load history was reused for new work with disabled fleet.");
    await setDispatchDriverActive(targetDriver.id, true);
    await setDispatchTruckActive(targetTruck.id, true);
    const historyAfterPlanValidation = await historyCounts();

    drivers = await listDispatchDrivers({ activeOnly: false });
    trucks = await listDispatchTrucks({ activeOnly: false });
    for (const driver of drivers) await setDispatchDriverActive(driver.id, false);
    for (const truck of trucks) await setDispatchTruckActive(truck.id, false);
    assert((await listDispatchDrivers()).length === 0, "All-disabled driver state was not preserved.");
    assert((await listDispatchTrucks()).length === 0, "All-disabled truck state was not preserved.");
    const totalBeforeEnsure = {
      drivers: (await listDispatchDrivers({ activeOnly: false })).length,
      trucks: (await listDispatchTrucks({ activeOnly: false })).length
    };
    await ensureDispatchFleetSetup({
      drivers: [{ name: "Unexpected Seed Driver", login: "unexpected-seed-driver" }],
      trucks: [{ plate: "UNEXPECTED-SEED-TRUCK" }]
    });
    assert((await listDispatchDrivers({ activeOnly: false })).length === totalBeforeEnsure.drivers, "Disabling the last driver triggered default reseeding.");
    assert((await listDispatchTrucks({ activeOnly: false })).length === totalBeforeEnsure.trucks, "Disabling the last truck triggered default reseeding.");
    assert((await listDispatchDrivers()).length === 0, "Last-driver disable was silently reversed.");
    assert((await listDispatchTrucks()).length === 0, "Last-truck disable was silently reversed.");
    assert(JSON.stringify(historyAfterPlanValidation) === JSON.stringify(await historyCounts()), "Fleet status changes modified historical plans or statistics records.");

    return {
      drivers: totalBeforeEnsure.drivers,
      trucks: totalBeforeEnsure.trucks,
      disableEnable: true,
      inactiveManagementView: true,
      passwordHashesPreserved: true,
      allDisabledStatePreserved: true,
      stableFleetIdentityPreserved: true,
      disabledPlanAssignmentsRejected: true,
      completedLoadHistoryPreserved: true,
      historicalRecordsPreserved: true
    };
  });
  console.log(JSON.stringify(result));
} finally {
  await rollbackContext.rollback();
  await closeDb();
}
