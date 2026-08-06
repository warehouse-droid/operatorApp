// @ts-check

import { query } from "../db.js";
import { executeMbtCommand } from "./command-repository.js";
import { MbtError } from "./errors.js";
import {
  MBT_ADMIN_GATE_KEYS,
  MBT_ADMIN_WRITABLE_GATE_KEYS
} from "./feature-gate-catalog.js";
import { assertExpectedRevision, nextRevision } from "./revisions.js";

/**
 * @typedef {import("./audit-repository.js").MbtActor} MbtActor
 */

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError(`A feature flag ${label} is required.`);
  }
  return normalized;
}

/** @param {Record<string, unknown>} row */
function publicFlag(row) {
  return {
    flagKey: String(row.flag_key),
    enabled: row.enabled === true,
    description: String(row.description),
    revision: Number(row.revision),
    updatedBy: row.updated_by === null ? null : String(row.updated_by)
  };
}

/** @param {Record<string, unknown>} row */
function publicAdminFlag(row) {
  return {
    ...publicFlag(row),
    updatedAt: row.updated_at ?? null
  };
}

/** @type {Set<string>} */
const ADMIN_GATE_KEYS = new Set(MBT_ADMIN_GATE_KEYS);
/** @type {Set<string>} */
const ADMIN_WRITABLE_GATE_KEYS = new Set(MBT_ADMIN_WRITABLE_GATE_KEYS);

/** @returns {Promise<Record<string, unknown>[]>} */
export async function listMbtAdminFeatureFlags() {
  const result = await query(
    `SELECT flag_key, enabled, description, revision, updated_by, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = ANY($1::text[])
      ORDER BY flag_key`,
    [MBT_ADMIN_GATE_KEYS]
  );
  return result.rows.map((/** @type {Record<string, unknown>} */ row) => publicAdminFlag(row));
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.flagKey
 * @param {boolean} input.enabled
 * @param {number} input.expectedRevision
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 * @returns {Promise<{status: number, body: Record<string, unknown>, replayed: boolean}>}
 */
export async function updateMbtFeatureFlagState({
  actor,
  flagKey,
  enabled,
  expectedRevision,
  reason,
  idempotencyKey,
  correlationId,
  requestId
}) {
  const normalizedFlagKey = requiredText(flagKey, "key");
  if (!ADMIN_GATE_KEYS.has(normalizedFlagKey)) {
    throw new MbtError({
      status: 404,
      code: "MBT_FEATURE_FLAG_NOT_FOUND",
      message: "The MBT feature flag was not found."
    });
  }
  if (!ADMIN_WRITABLE_GATE_KEYS.has(normalizedFlagKey)) {
    throw new MbtError({
      status: 409,
      code: "MBT_FEATURE_FLAG_LOCKED",
      message: "This MBT feature flag is controlled by the deployment safety boundary."
    });
  }
  if (typeof enabled !== "boolean") {
    throw new MbtError({
      status: 400,
      code: "MBT_FEATURE_FLAG_STATE_REQUIRED",
      message: "A boolean enabled state is required."
    });
  }
  const normalizedReason = requiredText(reason, "update reason");
  const payload = {
    flagKey: normalizedFlagKey,
    enabled,
    expectedRevision,
    reason: normalizedReason
  };
  return executeMbtCommand({
    actor,
    commandName: "mbt.feature_flag.state_updated",
    idempotencyKey,
    payload,
    correlationId,
    requestId,
    mutation: async () => {
      const selected = await query(
        `SELECT flag_key, enabled, description, revision, updated_by, updated_at
           FROM mbt_feature_flags
          WHERE flag_key = $1
          FOR UPDATE`,
        [normalizedFlagKey]
      );
      if (!selected.rowCount) {
        throw new MbtError({
          status: 404,
          code: "MBT_FEATURE_FLAG_NOT_FOUND",
          message: "The MBT feature flag was not found."
        });
      }
      const before = publicFlag(selected.rows[0]);
      assertExpectedRevision(Number(before.revision), expectedRevision);
      const revision = nextRevision(Number(before.revision));
      const updated = await query(
        `UPDATE mbt_feature_flags
            SET enabled = $2,
                revision = $3,
                updated_by = $4,
                updated_at = now()
          WHERE flag_key = $1
        RETURNING flag_key, enabled, description, revision, updated_by, updated_at`,
        [normalizedFlagKey, enabled, revision, actor.operatorId]
      );
      const after = publicFlag(updated.rows[0]);
      return {
        status: 200,
        body: { flag: after },
        audit: {
          action: "mbt.feature_flag.state_updated",
          entityType: "mbt_feature_flag",
          entityId: normalizedFlagKey,
          beforeState: before,
          afterState: after,
          reason: normalizedReason,
          revisionBefore: Number(before.revision),
          revisionAfter: Number(after.revision)
        }
      };
    }
  });
}

/**
 * Preserve the original revision-guarded description maintenance command for
 * existing Admin clients. State changes use the separately allowlisted local
 * gate command above.
 *
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.flagKey
 * @param {string} input.description
 * @param {number} input.expectedRevision
 * @param {string} input.reason
 * @param {string} [input.commandName]
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 * @param {readonly string[]} [input.secretValues]
 * @returns {Promise<{status: number, body: Record<string, unknown>, replayed: boolean}>}
 */
export async function updateMbtFeatureFlagDescription({
  actor,
  flagKey,
  description,
  expectedRevision,
  reason,
  commandName = "mbt.feature_flag.description_updated",
  idempotencyKey,
  correlationId,
  requestId,
  secretValues = []
}) {
  const normalizedFlagKey = requiredText(flagKey, "key");
  const normalizedDescription = String(description ?? "");
  const normalizedReason = requiredText(reason, "update reason");
  const payload = {
    flagKey: normalizedFlagKey,
    description: normalizedDescription,
    expectedRevision,
    reason: normalizedReason
  };
  return executeMbtCommand({
    actor,
    commandName,
    idempotencyKey,
    payload,
    correlationId,
    requestId,
    secretValues,
    mutation: async () => {
      const selected = await query(
        `SELECT flag_key, enabled, description, revision, updated_by, updated_at
           FROM mbt_feature_flags
          WHERE flag_key = $1
          FOR UPDATE`,
        [normalizedFlagKey]
      );
      if (!selected.rowCount) {
        throw new MbtError(/** @type {any} */ ({
          status: 404,
          code: "MBT_FEATURE_FLAG_NOT_FOUND",
          message: "The MBT feature flag was not found."
        }));
      }
      const before = publicFlag(selected.rows[0]);
      assertExpectedRevision(before.revision, expectedRevision);
      const revision = nextRevision(before.revision);
      const updated = await query(
        `UPDATE mbt_feature_flags
            SET description = $2,
                revision = $3,
                updated_by = $4,
                updated_at = now()
          WHERE flag_key = $1
        RETURNING flag_key, enabled, description, revision, updated_by, updated_at`,
        [normalizedFlagKey, normalizedDescription, revision, actor.operatorId]
      );
      const after = publicFlag(updated.rows[0]);
      return {
        status: 200,
        body: { flag: after },
        audit: {
          action: "mbt.feature_flag.description_updated",
          entityType: "mbt_feature_flag",
          entityId: normalizedFlagKey,
          beforeState: before,
          afterState: after,
          reason: normalizedReason,
          revisionBefore: before.revision,
          revisionAfter: after.revision
        }
      };
    }
  });
}
