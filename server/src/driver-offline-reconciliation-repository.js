import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_TYPES = new Set(["dvir", "duty"]);

function reconciliationError(message, status = 400, code = "DRIVER_OFFLINE_RECONCILIATION_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function requiredText(value, label, maxLength = 512) {
  const text = String(value ?? "").trim();
  if (!text) throw reconciliationError(`${label} is required.`);
  if (text.length > maxLength) throw reconciliationError(`${label} is too long.`);
  return text;
}

function uuidValue(value, label) {
  const text = requiredText(value, label, 64).toLowerCase();
  if (!UUID_PATTERN.test(text)) throw reconciliationError(`${label} must be a UUID.`);
  return text;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])])
    );
  }
  if (value === undefined) return null;
  return value;
}

function contextHash(context) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalValue(context || {})))
    .digest("hex");
}

function mapReceipt(row) {
  if (!row) return null;
  return {
    receiptId: row.receipt_id,
    eventId: row.event_id,
    driverLogin: row.driver_login,
    deviceId: row.device_id,
    actionType: row.action_type,
    contextHash: row.context_hash,
    context: row.request_context || {},
    status: row.status,
    result: row.result || {},
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

function normalizedIdentity({ eventId, driverLogin, deviceId, actionType, context = {} } = {}) {
  const action = requiredText(actionType, "Reconciliation action", 40).toLowerCase();
  if (!ACTION_TYPES.has(action)) {
    throw reconciliationError("Reconciliation action is not supported.");
  }
  const normalizedContext = canonicalValue(context || {});
  return {
    eventId: uuidValue(eventId, "Offline event ID"),
    driverLogin: requiredText(driverLogin, "Driver login", 160).toLowerCase(),
    deviceId: requiredText(deviceId, "Driver device ID", 160),
    actionType: action,
    context: normalizedContext,
    contextHash: contextHash(normalizedContext)
  };
}

function assertReceiptIdentity(row, identity) {
  if (
    String(row.driver_login).toLowerCase() !== identity.driverLogin
    || String(row.device_id) !== identity.deviceId
    || String(row.action_type) !== identity.actionType
    || String(row.context_hash) !== identity.contextHash
  ) {
    throw reconciliationError(
      "This offline event already has a reconciliation receipt for different evidence.",
      409,
      "DRIVER_OFFLINE_RECONCILIATION_IDEMPOTENCY_CONFLICT"
    );
  }
}

export function driverOfflineReconciliationDateSafety(planDate, currentTorontoDate) {
  const eventDate = String(planDate || "").slice(0, 10);
  const currentDate = String(currentTorontoDate || "").slice(0, 10);
  const valid = /^\d{4}-\d{2}-\d{2}$/;
  if (!valid.test(eventDate) || !valid.test(currentDate)) {
    return {
      allowed: false,
      reason: "The offline event date could not be validated for Samsara reconciliation."
    };
  }
  if (eventDate !== currentDate) {
    return {
      allowed: false,
      reason: `Samsara reconciliation is limited to the active Toronto driver day. This evidence is for ${eventDate}.`
    };
  }
  return { allowed: true, reason: "" };
}

export async function beginDriverOfflineReconciliationReceipt(input = {}) {
  const identity = normalizedIdentity(input);
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`driver-offline-reconciliation:${identity.eventId}`]);
    const existing = await query(
      `SELECT *
         FROM driver_offline_reconciliation_receipts
        WHERE event_id = $1::uuid
        FOR UPDATE`,
      [identity.eventId]
    );
    if (existing.rowCount) {
      assertReceiptIdentity(existing.rows[0], identity);
      return { execute: false, receipt: mapReceipt(existing.rows[0]) };
    }
    const receiptId = crypto.randomUUID();
    const inserted = await query(
      `INSERT INTO driver_offline_reconciliation_receipts (
         receipt_id, event_id, driver_login, device_id, action_type,
         context_hash, request_context, status
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, 'executing')
       RETURNING *`,
      [
        receiptId,
        identity.eventId,
        identity.driverLogin,
        identity.deviceId,
        identity.actionType,
        identity.contextHash,
        JSON.stringify(identity.context)
      ]
    );
    return { execute: true, receipt: mapReceipt(inserted.rows[0]) };
  });
}

export async function completeDriverOfflineReconciliationReceipt(receiptId, result = {}) {
  const id = uuidValue(receiptId, "Reconciliation receipt ID");
  return withTransaction(async () => {
    const updated = await query(
      `UPDATE driver_offline_reconciliation_receipts
          SET status = 'applied',
              result = $2::jsonb,
              error_code = '',
              error_message = '',
              completed_at = COALESCE(completed_at, now()),
              updated_at = now()
        WHERE receipt_id = $1::uuid
          AND status = 'executing'
      RETURNING *`,
      [id, JSON.stringify(result || {})]
    );
    if (updated.rowCount) return mapReceipt(updated.rows[0]);
    const existing = await query(
      "SELECT * FROM driver_offline_reconciliation_receipts WHERE receipt_id = $1::uuid",
      [id]
    );
    if (existing.rows[0]?.status === "applied") return mapReceipt(existing.rows[0]);
    throw reconciliationError(
      "The Samsara reconciliation outcome is uncertain and cannot be overwritten.",
      409,
      "DRIVER_OFFLINE_RECONCILIATION_UNCERTAIN"
    );
  });
}

export async function markDriverOfflineReconciliationReceiptUncertain(receiptId, error, result = {}) {
  const id = uuidValue(receiptId, "Reconciliation receipt ID");
  const errorCode = String(error?.code || "DRIVER_OFFLINE_RECONCILIATION_OUTCOME_UNCERTAIN").slice(0, 160);
  const errorMessage = String(error?.message || error || "Samsara reconciliation outcome is uncertain.").slice(0, 2000);
  const updated = await query(
    `UPDATE driver_offline_reconciliation_receipts
        SET status = 'uncertain',
            result = COALESCE(result, '{}'::jsonb) || $2::jsonb,
            error_code = $3,
            error_message = $4,
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
      WHERE receipt_id = $1::uuid
        AND status = 'executing'
    RETURNING *`,
    [id, JSON.stringify(result || {}), errorCode, errorMessage]
  );
  if (updated.rowCount) return mapReceipt(updated.rows[0]);
  const existing = await query(
    "SELECT * FROM driver_offline_reconciliation_receipts WHERE receipt_id = $1::uuid",
    [id]
  );
  return mapReceipt(existing.rows[0]);
}

export async function releaseDriverOfflineReconciliationReceipt(receiptId) {
  const id = uuidValue(receiptId, "Reconciliation receipt ID");
  const deleted = await query(
    `DELETE FROM driver_offline_reconciliation_receipts
      WHERE receipt_id = $1::uuid
        AND status = 'executing'
    RETURNING receipt_id`,
    [id]
  );
  return deleted.rowCount > 0;
}

export async function getDriverOfflineReconciliationReceipt(eventId) {
  const id = uuidValue(eventId, "Offline event ID");
  const result = await query(
    "SELECT * FROM driver_offline_reconciliation_receipts WHERE event_id = $1::uuid",
    [id]
  );
  return mapReceipt(result.rows[0]);
}
