import { closeDb, query } from "./db.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const dispatchV2CutoverChecks = [
  {
    key: "activeEditLeases",
    sql: "SELECT count(*)::int AS count FROM dispatch_plan_edit_leases WHERE expires_at > now()"
  },
  {
    key: "activeDriverRests",
    sql: "SELECT count(*)::int AS count FROM driver_rest_records WHERE status = 'active' AND ended_at IS NULL"
  },
  {
    key: "activeDriverDays",
    sql: `SELECT count(*)::int AS count
            FROM driver_day_records
           WHERE on_duty_at IS NOT NULL
             AND off_duty_at IS NULL
             AND (plan_date >= CURRENT_DATE - 1 OR updated_at >= now() - interval '48 hours')`
  },
  {
    key: "inProgressDriverJobs",
    sql: `SELECT count(*)::int AS count
            FROM driver_job_records
           WHERE status = 'in_progress'
             AND (
               plan_date >= CURRENT_DATE - 1
               OR COALESCE(started_at, created_at) >= now() - interval '48 hours'
             )`
  },
  {
    key: "unresolvedTruckSwitches",
    sql: "SELECT count(*)::int AS count FROM driver_truck_switch_records WHERE status IN ('pending', 'attention')"
  }
];

export async function runDispatchV2CutoverPreflight(runQuery = query) {
  const counts = {};
  for (const check of dispatchV2CutoverChecks) {
    const result = await runQuery(check.sql);
    counts[check.key] = Number(result.rows[0]?.count || 0);
  }
  const blockerCount = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return { ok: blockerCount === 0, blockerCount, checks: counts };
}

const isDirectRun = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    const result = await runDispatchV2CutoverPreflight();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error("DispatchV2 cutover blocked. Clear active dispatch/driver work and run the update again.");
      process.exitCode = 2;
    }
  } finally {
    await closeDb();
  }
}
