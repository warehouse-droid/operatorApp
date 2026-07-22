import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import { runDispatchV2CutoverPreflight } from "./dispatch-v2-cutover-preflight.js";

const rollback = await beginRollbackContext();

try {
  await rollback.run(async () => {
    const baseline = await runDispatchV2CutoverPreflight();
    const driverLogin = `cutover-harness-${Date.now()}`;
    await query(
      `INSERT INTO driver_day_records (driver_login, plan_date, on_duty_at)
       VALUES ($1, '2098-07-22'::date, now())`,
      [driverLogin]
    );

    const blocked = await runDispatchV2CutoverPreflight();
    assert.equal(blocked.ok, false);
    assert.equal(blocked.checks.activeDriverDays, baseline.checks.activeDriverDays + 1);
    assert.equal(blocked.blockerCount, baseline.blockerCount + 1);

    await query(
      "UPDATE driver_day_records SET off_duty_at = now() WHERE driver_login = $1 AND plan_date = '2098-07-22'::date",
      [driverLogin]
    );
    const cleared = await runDispatchV2CutoverPreflight();
    assert.equal(cleared.checks.activeDriverDays, baseline.checks.activeDriverDays);
    assert.equal(cleared.blockerCount, baseline.blockerCount);
  });
  console.log(JSON.stringify({ ok: true, tests: 5 }));
} finally {
  await rollback.rollback();
  await closeDb();
}
