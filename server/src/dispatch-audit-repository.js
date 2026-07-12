import { query } from "./db.js";

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanJson(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}

function auditRow(row) {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    orderId: row.order_id,
    loadId: row.load_id,
    truckId: row.truck_id,
    planId: row.plan_id,
    planDate: row.plan_date,
    sessionId: row.session_id,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    source: row.source,
    before: row.before_state,
    after: row.after_state,
    details: row.details,
    createdAt: row.created_at
  };
}

export async function writeDispatchAudit(entry = {}) {
  const action = cleanText(entry.action);
  if (!action) throw new Error("Dispatch audit action is required.");
  const result = await query(
    `INSERT INTO dispatch_audit_log (
       action, entity_type, entity_id, order_id, load_id, truck_id,
       session_id, operator_id, operator_name, source, plan_id, plan_date,
       before_state, after_state, details
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'dispatch'), $11, $12::date, $13::jsonb, $14::jsonb, COALESCE($15::jsonb, '{}'::jsonb))
     RETURNING *`,
    [
      action,
      cleanText(entry.entityType || entry.entity_type),
      cleanText(entry.entityId || entry.entity_id),
      cleanText(entry.orderId || entry.order_id),
      cleanText(entry.loadId || entry.load_id),
      cleanText(entry.truckId || entry.truck_id),
      cleanText(entry.sessionId || entry.session_id),
      entry.operatorId || entry.operator_id || null,
      cleanText(entry.operatorName || entry.operator_name),
      cleanText(entry.source),
      entry.planId || entry.plan_id || null,
      cleanText(entry.planDate || entry.plan_date),
      JSON.stringify(cleanJson(entry.before, null)),
      JSON.stringify(cleanJson(entry.after, null)),
      JSON.stringify(cleanJson(entry.details, {}))
    ]
  );
  return auditRow(result.rows[0]);
}

export async function listDispatchAudit({ limit = 200 } = {}) {
  const cleanLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const result = await query(
    `SELECT *
       FROM dispatch_audit_log
      ORDER BY created_at DESC
      LIMIT $1`,
    [cleanLimit]
  );
  return result.rows.map(auditRow);
}
