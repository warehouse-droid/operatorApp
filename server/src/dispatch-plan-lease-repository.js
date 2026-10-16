import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";

export const DISPATCH_PLAN_EDIT_LEASE_SECONDS = 10 * 60;

export async function lockDispatchPlanEditLeaseDate(planDate) {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dispatch-edit-lease:${cleanPlanDate(planDate)}`]);
}

// Caller holds the fleet lock first. Holding this date lock through COMMIT
// orders a delayed save against release, reacquisition and absent-row inserts.
export async function lockDispatchPlanEditLease(input) {
  if (!input) {return;}
  await lockDispatchPlanEditLeaseDate(input.planDate);
  return assertDispatchPlanEditLease(input);
}

function cleanPlanDate(value) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const error = new Error("A valid dispatch plan date is required.");
    error.status = 400;
    throw error;
  }
  return text;
}

function cleanSessionId(value) {
  const sessionId = String(value || "").trim();
  if (!sessionId) {
    const error = new Error("A dispatch browser session is required.");
    error.status = 400;
    throw error;
  }
  return sessionId;
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function leaseRow(row, { active = false } = {}) {
  if (!row) return null;
  return {
    planDate: String(row.plan_date || "").slice(0, 10),
    operatorId: row.operator_id || "",
    operatorName: row.operator_name || "",
    sessionId: row.session_id || "",
    acquiredAt: row.acquired_at || "",
    heartbeatAt: row.heartbeat_at || "",
    expiresAt: row.expires_at || "",
    selectionId: tokenHash(row.token_hash),
    active
  };
}

export class DispatchPlanEditLeaseError extends Error {
  constructor(message, { code = "DISPATCH_PLAN_EDIT_LEASE_REQUIRED", lease = null } = {}) {
    super(message);
    this.name = "DispatchPlanEditLeaseError";
    this.code = code;
    this.lease = lease;
    this.status = 409;
  }
}

export async function getDispatchPlanEditLease(planDate) {
  const cleanDate = cleanPlanDate(planDate);
  const result = await query(
    `SELECT plan_date::text, operator_id, operator_name, session_id, token_hash,
            acquired_at, heartbeat_at, expires_at,
            expires_at > clock_timestamp() AS active
       FROM dispatch_plan_edit_leases
      WHERE plan_date = $1::date`,
    [cleanDate]
  );
  return leaseRow(result.rows[0], { active: Boolean(result.rows[0]?.active) });
}

export async function acquireDispatchPlanEditLease({ planDate, operatorId, operatorName, sessionId }) {
  const cleanDate = cleanPlanDate(planDate);
  const cleanSession = cleanSessionId(sessionId);
  const cleanOperatorId = String(operatorId || "").trim();
  if (!cleanOperatorId) throw new Error("Dispatcher account is required.");
  const nextToken = crypto.randomBytes(32).toString("base64url");
  const nextTokenHash = tokenHash(nextToken);

  return withTransaction(async () => {
    await lockDispatchPlanEditLeaseDate(cleanDate);
    const existingResult = await query(
      `SELECT plan_date::text, operator_id, operator_name, session_id, token_hash,
              acquired_at, heartbeat_at, expires_at, expires_at > clock_timestamp() AS active
         FROM dispatch_plan_edit_leases
        WHERE plan_date = $1::date
        FOR UPDATE`,
      [cleanDate]
    );
    const existing = existingResult.rows[0];
    const sameEditor = existing
      && existing.operator_id === cleanOperatorId
      && existing.session_id === cleanSession
      && Boolean(existing.active);
    if (existing?.active && !sameEditor) {
      throw new DispatchPlanEditLeaseError(
        `${existing.operator_name || "Another dispatcher"} is editing this plan until ${new Date(existing.expires_at).toLocaleTimeString()}.`,
        { code: "DISPATCH_PLAN_EDIT_LEASE_HELD", lease: leaseRow(existing, { active: true }) }
      );
    }

    const replacedExpired = Boolean(existing && !existing.active);
    if (sameEditor) {
      const renewed = await query(
        `UPDATE dispatch_plan_edit_leases
            SET heartbeat_at = now(),
                token_hash = $3,
                expires_at = now() + ($2::int * interval '1 second'),
                updated_at = now()
          WHERE plan_date = $1::date
          RETURNING plan_date::text, operator_id, operator_name, session_id, token_hash, acquired_at, heartbeat_at, expires_at`,
        [cleanDate, DISPATCH_PLAN_EDIT_LEASE_SECONDS, nextTokenHash]
      );
      return { lease: leaseRow(renewed.rows[0], { active: true }), token: nextToken, renewed: true, replacedExpired: false };
    }

    const saved = await query(
      `INSERT INTO dispatch_plan_edit_leases (
         plan_date, operator_id, operator_name, session_id, token_hash, acquired_at, heartbeat_at, expires_at, updated_at
       ) VALUES (
         $1::date, $2, $3, $4, $5, now(), now(), now() + ($6::int * interval '1 second'), now()
       )
       ON CONFLICT (plan_date) DO UPDATE
         SET operator_id = EXCLUDED.operator_id,
             operator_name = EXCLUDED.operator_name,
             session_id = EXCLUDED.session_id,
             token_hash = EXCLUDED.token_hash,
             acquired_at = now(),
             heartbeat_at = now(),
             expires_at = now() + ($6::int * interval '1 second'),
             updated_at = now()
       RETURNING plan_date::text, operator_id, operator_name, session_id, token_hash, acquired_at, heartbeat_at, expires_at`,
      [cleanDate, cleanOperatorId, String(operatorName || "").trim(), cleanSession, nextTokenHash, DISPATCH_PLAN_EDIT_LEASE_SECONDS]
    );
    return { lease: leaseRow(saved.rows[0], { active: true }), token: nextToken, renewed: false, replacedExpired };
  });
}

export async function heartbeatDispatchPlanEditLease({ planDate, operatorId, sessionId, token, activityAgeMs = undefined }) {
  const cleanDate = cleanPlanDate(planDate);
  const cleanSession = cleanSessionId(sessionId);
  if (activityAgeMs !== undefined && (typeof activityAgeMs !== "number" || !Number.isFinite(activityAgeMs) || activityAgeMs < 0)) {
    throw Object.assign(new Error("A valid activity age is required."), { status: 400 });
  }
  if (activityAgeMs >= DISPATCH_PLAN_EDIT_LEASE_SECONDS * 1000) {
    throw new DispatchPlanEditLeaseError("Edit Mode ended after 10 minutes without activity.", { code: "DISPATCH_PLAN_EDIT_LEASE_EXPIRED" });
  }
  return withTransaction(async () => {
  await lockDispatchPlanEditLeaseDate(cleanDate);
  const result = await query(
    `UPDATE dispatch_plan_edit_leases
        SET heartbeat_at = CASE WHEN $6::double precision IS NULL THEN heartbeat_at
              ELSE GREATEST(heartbeat_at, clock_timestamp() - ($6::double precision * interval '1 millisecond')) END,
            expires_at = CASE WHEN $6::double precision IS NULL THEN expires_at
              ELSE GREATEST(heartbeat_at, clock_timestamp() - ($6::double precision * interval '1 millisecond'))
                   + ($5::int * interval '1 second') END,
            updated_at = now()
      WHERE plan_date = $1::date
        AND operator_id = $2
        AND session_id = $3
        AND token_hash = $4
        AND expires_at > clock_timestamp()
      RETURNING plan_date::text, operator_id, operator_name, session_id, token_hash, acquired_at, heartbeat_at, expires_at`,
    [cleanDate, String(operatorId || ""), cleanSession, tokenHash(token), DISPATCH_PLAN_EDIT_LEASE_SECONDS, activityAgeMs ?? null]
  );
  if (!result.rows[0]) {
    const lease = await getDispatchPlanEditLease(cleanDate);
    throw new DispatchPlanEditLeaseError("Edit mode has expired or belongs to another dispatcher.", {
      code: "DISPATCH_PLAN_EDIT_LEASE_EXPIRED",
      lease
    });
  }
  return leaseRow(result.rows[0], { active: true });
  });
}

export async function assertDispatchPlanEditLease({ planDate, operatorId, sessionId, token }) {
  const cleanDate = cleanPlanDate(planDate);
  const cleanSession = cleanSessionId(sessionId);
  const result = await query(
    `SELECT plan_date::text, operator_id, operator_name, session_id, token_hash, acquired_at, heartbeat_at, expires_at
       FROM dispatch_plan_edit_leases
      WHERE plan_date = $1::date
        AND operator_id = $2
        AND session_id = $3
        AND token_hash = $4
        AND expires_at > clock_timestamp()`,
    [cleanDate, String(operatorId || ""), cleanSession, tokenHash(token)]
  );
  if (!result.rows[0]) {
    const lease = await getDispatchPlanEditLease(cleanDate);
    throw new DispatchPlanEditLeaseError("Enter Edit Mode before changing this dispatch plan.", { lease });
  }
  return leaseRow(result.rows[0], { active: true });
}

export async function releaseDispatchPlanEditLease({ planDate, operatorId, sessionId, token }) {
  const cleanDate = cleanPlanDate(planDate);
  const cleanSession = cleanSessionId(sessionId);
  return withTransaction(async () => {
  await lockDispatchPlanEditLeaseDate(cleanDate);
  const result = await query(
    `DELETE FROM dispatch_plan_edit_leases
      WHERE plan_date = $1::date
        AND operator_id = $2
        AND session_id = $3
        AND token_hash = $4
      RETURNING plan_date::text, operator_id, operator_name, session_id, token_hash, acquired_at, heartbeat_at, expires_at`,
    [cleanDate, String(operatorId || ""), cleanSession, tokenHash(token)]
  );
  return leaseRow(result.rows[0], { active: false });
  });
}

export async function listActiveDispatchPlanEditors() {
  const result = await query(`SELECT plan_date::text, operator_id, operator_name, session_id, token_hash,
      acquired_at, heartbeat_at, expires_at FROM dispatch_plan_edit_leases
      WHERE expires_at > clock_timestamp() ORDER BY plan_date, operator_name`);
  return result.rows.map(row => leaseRow(row, { active: true }));
}

export async function kickDispatchPlanEditor(input, actor) {
  const planDate = cleanPlanDate(input?.planDate);
  const sessionId = cleanSessionId(input?.sessionId);
  if (!input?.operatorId || !input?.acquiredAt || !Number.isFinite(Date.parse(input.acquiredAt))
      || !/^[a-f0-9]{64}$/.test(String(input.selectionId || ""))) {
    throw Object.assign(new Error("Refresh the editor list and select the user to kick out."), { status: 400 });
  }
  return withTransaction(async () => {
    await lockDispatchPlanEditLeaseDate(planDate);
    const current = await getDispatchPlanEditLease(planDate);
    if (!current?.active) {return null;}
    if (current.operatorId !== input.operatorId || current.sessionId !== sessionId || current.selectionId !== input.selectionId) {
      throw new DispatchPlanEditLeaseError("The editor changed. Refresh and confirm the current user.", {
        code: "DISPATCH_PLAN_EDIT_LEASE_CHANGED", lease: current
      });
    }
    await query("DELETE FROM dispatch_plan_edit_leases WHERE plan_date=$1::date", [planDate]);
    await writeDispatchAudit({ action: actor.admin ? "dispatch_plan_edit_lease_admin_kicked" : "dispatch_plan_edit_lease_kicked",
      entityType: "plan", entityId: planDate, planDate, operatorId: actor.id, operatorName: actor.name,
      source: actor.admin ? "admin" : "dispatch", before: current,
      details: { removedOperatorId: current.operatorId, removedOperatorName: current.operatorName, removedSessionId: current.sessionId } });
    return current;
  });
}
