import { query } from "./db.js";

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function cleanPlanDate(value) {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : todayDate();
}

function planRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    planDate: row.plan_date instanceof Date ? row.plan_date.toISOString().slice(0, 10) : String(row.plan_date || "").slice(0, 10),
    status: row.status,
    note: row.note || "",
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    savedAt: row.saved_at || row.updated_at,
    orders: row.orders || [],
    trucks: row.trucks || [],
    summary: row.summary || {}
  };
}

export async function listDispatchPlans({ limit = 80 } = {}) {
  const cleanLimit = Math.min(Math.max(Number(limit) || 80, 1), 300);
  const result = await query(
    `SELECT p.*, s.saved_at, s.summary
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      ORDER BY p.plan_date DESC, p.updated_at DESC
      LIMIT $1`,
    [cleanLimit]
  );
  return result.rows.map(planRow);
}

export async function createDispatchPlan({ planDate, note = "", status = "draft" } = {}) {
  const cleanDate = cleanPlanDate(planDate);
  const result = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (plan_date) DO UPDATE
       SET updated_at = dispatch_plans.updated_at
     RETURNING *`,
    [cleanDate, status, note || ""]
  );
  const plan = result.rows[0];
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
     ON CONFLICT (plan_id) DO NOTHING`,
    [plan.id]
  );
  return getDispatchPlan(plan.id);
}

export async function getDispatchPlan(planId) {
  const result = await query(
    `SELECT p.*, s.saved_at, s.orders, s.trucks, s.summary
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [planId]
  );
  return planRow(result.rows[0]);
}

export async function getCurrentDispatchPlan({ planDate } = {}) {
  const cleanDate = cleanPlanDate(planDate);
  const result = await query(
    `SELECT p.*, s.saved_at, s.orders, s.trucks, s.summary
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.plan_date = $1
      LIMIT 1`,
    [cleanDate]
  );
  return planRow(result.rows[0]);
}

export async function saveDispatchPlanSnapshot(planId, { orders = [], trucks = [], summary = {} } = {}) {
  const result = await query(
    `UPDATE dispatch_plans
        SET updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [planId]
  );
  if (!result.rows[0]) throw new Error("Dispatch plan not found.");
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, saved_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, now())
     ON CONFLICT (plan_id) DO UPDATE
       SET orders = EXCLUDED.orders,
           trucks = EXCLUDED.trucks,
           summary = EXCLUDED.summary,
           saved_at = now()`,
    [planId, JSON.stringify(orders), JSON.stringify(trucks), JSON.stringify(summary || {})]
  );
  return getDispatchPlan(planId);
}

export async function confirmDispatchPlan(planId, { note = "" } = {}) {
  const result = await query(
    `UPDATE dispatch_plans
        SET status = 'confirmed',
            note = COALESCE(NULLIF($2, ''), note),
            confirmed_at = COALESCE(confirmed_at, now()),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [planId, note || ""]
  );
  if (!result.rows[0]) throw new Error("Dispatch plan not found.");
  return getDispatchPlan(planId);
}

export async function reopenDispatchPlan(planId, { note = "" } = {}) {
  const result = await query(
    `UPDATE dispatch_plans
        SET status = 'draft',
            note = COALESCE(NULLIF($2, ''), note),
            confirmed_at = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [planId, note || ""]
  );
  if (!result.rows[0]) throw new Error("Dispatch plan not found.");
  return getDispatchPlan(planId);
}
