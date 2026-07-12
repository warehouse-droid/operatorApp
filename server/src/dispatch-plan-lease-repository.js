import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";

export const DISPATCH_PLAN_EDIT_LEASE_SECONDS = 10 * 60;

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
    `SELECT plan_date::text, operator_id, operator_name, session_id,
            acquired_at, heartbeat_at, expires_at,
            expires_at > now() AS active
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
    const existingResult = await query(
      `SELECT plan_date::text, operator_id, operator_name, session_id, token_hash,
              acquired_at, heartbeat_at, expires_at, expires_at > now() AS active
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
          RETURNING plan_date::text, operator_id, operator_name, session_id, acquired_at, heartbeat_at, expires_at`,
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
       RETURNING plan_date::text, operator_id, operator_name, session_id, acquired_at, heartbeat_at, expires_at`,
      [cleanDate, cleanOperatorId, String(operatorName || "").trim(), cleanSession, nextTokenHash, DISPATCH_PLAN_EDIT_LEASE_SECONDS]
    );
    return { lease: leaseRow(saved.rows[0], { active: true }), token: nextToken, renewed: false, replacedExpired };
  });
}

export async function heartbeatDispatchPlanEditLease({ planDate, operatorId, sessionId, token }) {
  const cleanDate = cleanPlanDate(planDate);
  const cleanSession = cleanSessionId(sessionId);
  const result = await query(
    `UPDATE dispatch_plan_edit_leases
        SET heartbeat_at = now(),
            expires_at = now() + ($5::int * interval '1 second'),
            updated_at = now()
      WHERE plan_date = $1::date
        AND operator_id = $2
        AND session_id = $3
        AND token_hash = $4
        AND expires_at > now()
      RETURNING plan_date::text, operator_id, operator_name, session_id, acquired_at, heartbeat_at, expires_at`,
    [cleanDate, String(operatorId || ""), cleanSession, tokenHash(token), DISPATCH_PLAN_EDIT_LEASE_SECONDS]
  );
  if (!result.rows[0]) {
    const lease = await getDispatchPlanEditLease(cleanDate);
    throw new DispatchPlanEditLeaseError("Edit mode has expired or belongs to another dispatcher.", {
      code: "DISPATCH_PLAN_EDIT_LEASE_EXPIRED",
      lease
    });
  }
  return leaseRow(result.rows[0], { active: true });
}

export async function assertDispatchPlanEditLease({ planDate, operatorId, sessionId, token }) {
  const cleanDate = cleanPlanDate(planDate);
  const cleanSession = cleanSessionId(sessionId);
  const result = await query(
    `SELECT plan_date::text, operator_id, operator_name, session_id, acquired_at, heartbeat_at, expires_at
       FROM dispatch_plan_edit_leases
      WHERE plan_date = $1::date
        AND operator_id = $2
        AND session_id = $3
        AND token_hash = $4
        AND expires_at > now()`,
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
  const result = await query(
    `DELETE FROM dispatch_plan_edit_leases
      WHERE plan_date = $1::date
        AND operator_id = $2
        AND session_id = $3
        AND token_hash = $4
      RETURNING plan_date::text, operator_id, operator_name, session_id, acquired_at, heartbeat_at, expires_at`,
    [cleanDate, String(operatorId || ""), cleanSession, tokenHash(token)]
  );
  return leaseRow(result.rows[0], { active: false });
}
