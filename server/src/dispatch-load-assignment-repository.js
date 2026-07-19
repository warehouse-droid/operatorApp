import { query, withTransaction } from "./db.js";
import { flattenDispatchPlanLoads, normalizeDispatchPlanLoadAssignments } from "./dispatch-load-assignment.js";

function text(value) {
  return String(value ?? "").trim();
}

export async function syncDispatchPlanLoadAssignments(plan = {}) {
  const normalized = normalizeDispatchPlanLoadAssignments(plan);
  const planId = normalized.id ?? normalized.planId;
  if (!planId) return normalized;
  const rows = flattenDispatchPlanLoads(normalized).filter((row) => text(row.load.id));
  const statusResult = await query(
    `SELECT load_id,
            bool_or(status IN ('in_progress', 'complete')) AS started,
            bool_and(status = 'complete') FILTER (WHERE status IN ('in_progress', 'complete')) AS completed
       FROM driver_job_records
      WHERE plan_id = $1
        AND status IN ('in_progress', 'complete')
      GROUP BY load_id`,
    [planId]
  );
  const statusByLoad = new Map(statusResult.rows.map((row) => [text(row.load_id), row]));
  await query("DELETE FROM dispatch_plan_load_assignments WHERE plan_id = $1", [planId]);
  if (!rows.length) return normalized;

  const values = [];
  const placeholders = rows.map((row, index) => {
    const offset = index * 18;
    const status = statusByLoad.get(text(row.load.id));
    values.push(
      planId,
      row.planDate || normalized.planDate,
      text(row.load.id),
      text(row.load.name),
      row.driverLogin,
      row.driverName,
      row.truckId,
      row.truckPlate,
      row.switchYard,
      row.parkingSpot,
      row.plannedStartMinute,
      row.plannedFinishMinute,
      row.driverSequence,
      Boolean(status?.started),
      Boolean(status?.completed),
      JSON.stringify({ truckIndex: row.truckIndex, loadIndex: row.loadIndex, returnOnly: Boolean(row.load.returnOnly) }),
      new Date(),
      new Date()
    );
    return `(${Array.from({ length: 18 }, (_, fieldIndex) => `$${offset + fieldIndex + 1}`).join(", ")})`;
  });
  await query(
    `INSERT INTO dispatch_plan_load_assignments (
       plan_id, plan_date, load_id, load_name, driver_login, driver_name,
       truck_id, truck_plate, switch_yard, parking_spot,
       planned_start_minute, planned_finish_minute, driver_sequence,
       started, completed, assignment, created_at, updated_at
     ) VALUES ${placeholders.join(", ")}`,
    values
  );
  return normalized;
}

export async function rebuildDispatchPlanLoadAssignments({ planId = null } = {}) {
  return withTransaction(async () => {
    const result = await query(
      `SELECT p.id, p.plan_date::text AS plan_date, s.orders, s.trucks, s.summary
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE ($1::bigint IS NULL OR p.id = $1)
        ORDER BY p.plan_date, p.id`,
      [planId]
    );
    let loadCount = 0;
    for (const row of result.rows) {
      const plan = await syncDispatchPlanLoadAssignments({
        id: row.id,
        planDate: row.plan_date,
        orders: row.orders || [],
        trucks: row.trucks || [],
        summary: row.summary || {}
      });
      loadCount += flattenDispatchPlanLoads(plan).length;
    }
    return { planCount: result.rowCount, loadCount };
  });
}

export async function listDispatchPlanLoadAssignments({ planId = null, planDate = "", driverLogin = "" } = {}) {
  const result = await query(
    `SELECT *
       FROM dispatch_plan_load_assignments
      WHERE ($1::bigint IS NULL OR plan_id = $1)
        AND (NULLIF($2, '') IS NULL OR plan_date = $2::date)
        AND (NULLIF($3, '') IS NULL OR lower(driver_login) = lower($3))
      ORDER BY plan_date, lower(driver_login), planned_start_minute NULLS LAST, driver_sequence, id`,
    [planId, text(planDate), text(driverLogin)]
  );
  return result.rows;
}
