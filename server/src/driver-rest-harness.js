import { beginRollbackContext, closeDb, query } from "./db.js";
import { getDispatchStatistics } from "./dispatch-statistics-repository.js";
import {
  endDriverRest,
  getDriverRestSummary,
  startDriverRest
} from "./driver-repository.js";

const suffix = String(Date.now()).slice(-8);
const driverLogin = `rest-harness-${suffix}`;
const jobId = `rest-job-${suffix}`;
const firstRestId = `rest-complete-${suffix}`;
const planDate = "2098-07-16";

function assert(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_date, driver_login, truck_id, truck_plate, load_id, load_name,
         stop_id, stop_type, order_refs, photo_data_urls, status, started_at, completed_at
       ) VALUES (
         $1, $2::date, $3, 'REST-TRUCK', 'REST-101', 'REST-LOAD', 'Rest Harness Load',
         'REST-STOP', 'travel', '[]'::jsonb, '[]'::jsonb, 'in_progress',
         now() - interval '60 minutes', NULL
       )`,
      [jobId, planDate, driverLogin]
    );
    await query(
      `INSERT INTO driver_rest_records (
         rest_id, plan_date, driver_login, truck_id, truck_plate, load_id, load_name,
         next_job_id, status, started_at, ended_at
       ) VALUES (
         $1, $2::date, $3, 'REST-TRUCK', 'REST-101', 'REST-LOAD', 'Rest Harness Load',
         $4, 'complete', now() - interval '45 minutes', now() - interval '15 minutes'
       )`,
      [firstRestId, planDate, driverLogin, jobId]
    );

    const beforeSecondRest = await getDriverRestSummary(driverLogin, { planDate });
    assert(beforeSecondRest.sessionCount === 1
        && beforeSecondRest.completedSeconds >= 1799
        && beforeSecondRest.completedSeconds <= 1801,
      "The first 30-minute rest must be persisted in the daily accumulated total.",
      { beforeSecondRest });

    const activeRest = await startDriverRest(driverLogin, {
      nextJob: {
        jobId,
        planId: null,
        planDate,
        status: "in_progress",
        truckId: "REST-TRUCK",
        truckPlate: "REST-101",
        loadId: "REST-LOAD",
        loadName: "Rest Harness Load"
      }
    });
    assert(activeRest?.status === "active" && activeRest.nextJobId === jobId,
      "Rest must be allowed while the current stop is in progress.",
      { activeRest });

    const duringSecondRest = await getDriverRestSummary(driverLogin, { planDate });
    assert(duringSecondRest.sessionCount === 2
        && duringSecondRest.completedSeconds >= 1799
        && duringSecondRest.totalSeconds >= duringSecondRest.completedSeconds,
      "A second rest session must start from the prior daily accumulated total.",
      { duringSecondRest });

    await endDriverRest(driverLogin);
    await query(
      `UPDATE driver_job_records
          SET status = 'complete',
              completed_at = now()
        WHERE job_id = $1`,
      [jobId]
    );

    const statistics = await getDispatchStatistics({
      from: planDate,
      to: planDate,
      driver: driverLogin
    });
    const stop = statistics.recentStops.find((entry) => entry.jobId === jobId);
    assert(stop
        && stop.grossMinutes === 60
        && stop.restMinutes >= 29.9
        && stop.restMinutes <= 30.1
        && stop.actualMinutes === 30,
      "A 60-minute stop with a 30-minute overlapping rest must report 30 net minutes.",
      { stop, summary: statistics.summary });
    assert(statistics.summary.totalRestMinutes >= 29.9
        && statistics.summary.totalRestMinutes <= 30.1,
      "Dispatch statistics must expose the rest time deducted from stop service time.",
      { summary: statistics.summary });
  });
  console.log("Driver rest rollback harness passed.");
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
} finally {
  await rollback.rollback();
  await closeDb();
}
