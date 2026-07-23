import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import { runDispatchV2CutoverPreflight } from "./dispatch-v2-cutover-preflight.js";

const rollback = await beginRollbackContext();

try {
  await rollback.run(async () => {
    const baseline = await runDispatchV2CutoverPreflight();
    const driverLogin = `cutover-harness-${Date.now()}`;
    const staleDriverLogin = `${driverLogin}-stale`;
    const staleJobId = `${driverLogin}-stale-job`;
    await query(
      `INSERT INTO driver_day_records (driver_login, plan_date, on_duty_at, updated_at)
       VALUES ($1, CURRENT_DATE - 7, now() - interval '7 days', now() - interval '7 days')`,
      [staleDriverLogin]
    );
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_date, driver_login, stop_type, status, completed_at, created_at, started_at
       ) VALUES (
         $1, CURRENT_DATE - 7, $2, 'travel', 'in_progress', NULL,
         now() - interval '7 days', now() - interval '7 days'
       )`,
      [staleJobId, staleDriverLogin]
    );
    const staleIgnored = await runDispatchV2CutoverPreflight();
    assert.equal(staleIgnored.checks.activeDriverDays, baseline.checks.activeDriverDays);
    assert.equal(staleIgnored.checks.inProgressDriverJobs, baseline.checks.inProgressDriverJobs);
    assert.equal(staleIgnored.blockerCount, baseline.blockerCount);

    const activeJobId = `${driverLogin}-active-job`;
    await query(
      `INSERT INTO driver_day_records (driver_login, plan_date, on_duty_at)
       VALUES ($1, CURRENT_DATE, now())`,
      [driverLogin]
    );
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_date, driver_login, stop_type, status, completed_at, started_at
       ) VALUES ($1, CURRENT_DATE, $2, 'travel', 'in_progress', NULL, now())`,
      [activeJobId, driverLogin]
    );

    const blocked = await runDispatchV2CutoverPreflight();
    assert.equal(blocked.ok, false);
    assert.equal(blocked.checks.activeDriverDays, baseline.checks.activeDriverDays + 1);
    assert.equal(blocked.checks.inProgressDriverJobs, baseline.checks.inProgressDriverJobs + 1);
    assert.equal(blocked.blockerCount, baseline.blockerCount + 2);

    await query(
      "UPDATE driver_day_records SET off_duty_at = now() WHERE driver_login = $1 AND plan_date = CURRENT_DATE",
      [driverLogin]
    );
    await query(
      "UPDATE driver_job_records SET status = 'complete', completed_at = now() WHERE job_id = $1",
      [activeJobId]
    );
    const cleared = await runDispatchV2CutoverPreflight();
    assert.equal(cleared.checks.activeDriverDays, baseline.checks.activeDriverDays);
    assert.equal(cleared.checks.inProgressDriverJobs, baseline.checks.inProgressDriverJobs);
    assert.equal(cleared.blockerCount, baseline.blockerCount);
  });
  console.log(JSON.stringify({ ok: true, tests: 10 }));
} finally {
  await rollback.rollback();
  await closeDb();
}
