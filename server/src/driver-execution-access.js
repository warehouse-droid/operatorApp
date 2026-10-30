// @ts-check
import { query } from "./db.js";

/**
 * Lock the current driver records for the execution transaction so inactivation
 * cannot commit between the status check and the write. Route callers also hold
 * the fleet planning lock when checking current plan ownership.
 * Historical jobs without a current setup record retain their existing policy;
 * authentication and route ownership are still checked by their callers.
 * @param {string} driverLogin
 * @param {{driverLogin?: string, planId?: string | number, loadId?: string} | null} [job]
 */
export async function assertDriverExecutionActive(driverLogin, job = null) {
  const logins = [...new Set([driverLogin, job?.driverLogin]
    .map(value => String(value || "").trim().toLowerCase()).filter(Boolean))];
  /** @type {import("pg").QueryResult<{login: string, active: boolean}>} */
  const drivers = await query(
    `SELECT driver.login, driver.active
       FROM dispatch_drivers driver
      WHERE (lower(btrim(driver.login)) = ANY($1::text[])
          OR EXISTS (
            SELECT 1 FROM dispatch_plan_load_assignments assignment
             WHERE assignment.plan_id = $2
               AND assignment.load_id = $3
               AND lower(btrim(assignment.driver_login)) = lower(btrim(driver.login))
          ))
      ORDER BY driver.id
      FOR SHARE OF driver`,
    [logins, job?.planId || null, job?.loadId || ""]
  );
  if (drivers.rows.some(driver => driver.active === false)) {
    throw Object.assign(new Error("This job is assigned to an inactive driver. Dispatch must reassign it to an active driver before work can start or complete."), {
      status: 409,
      code: "DRIVER_INACTIVE"
    });
  }
}
