// @ts-check

import { query } from "../db.js";
import { executeMbtCommand } from "./command-repository.js";
import { MbtError } from "./errors.js";

/** @param {number} status @param {string} code @param {string} message */
function failure(status, code, message) {
  return new MbtError({ status, code, message });
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw failure(400, "MBT_CUSTOMER_INPUT_INVALID", `${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value @param {number} fallback */
function listLimit(value, fallback = 50) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw failure(400, "MBT_CUSTOMER_LIMIT_INVALID", "Customer list limit must be from 1 to 100.");
  }
  return limit;
}

/** @param {unknown} value */
function cursor(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded.some((part) => !String(part))) {
      throw new Error("invalid cursor");
    }
    return decoded.map(String);
  } catch {
    throw failure(400, "MBT_CUSTOMER_CURSOR_INVALID", "The customer list cursor is invalid.");
  }
}

/** @param {unknown} first @param {unknown} second */
function encodeCursor(first, second) {
  /** @param {unknown} value */
  const encodePart = (value) => value instanceof Date ? value.toISOString() : String(value);
  return Buffer.from(JSON.stringify([encodePart(first), encodePart(second)]), "utf8").toString("base64url");
}

/** @param {Record<string, unknown>} row */
function publicRun(row) {
  return {
    runId: String(row.run_id),
    syncKind: String(row.sync_kind),
    status: String(row.status),
    accountId: String(row.account_id),
    subsidiaryId: row.subsidiary_id === null ? null : String(row.subsidiary_id),
    requestedBy: row.requested_by === null ? null : String(row.requested_by),
    pagesExpected: row.pages_expected === null ? null : Number(row.pages_expected),
    pagesApplied: Number(row.pages_applied),
    recordsSeen: Number(row.records_seen),
    recordsApplied: Number(row.records_applied),
    recordsConflicted: Number(row.records_conflicted),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    requestedAt: new Date(String(row.requested_at)).toISOString(),
    startedAt: row.started_at === null ? null : new Date(String(row.started_at)).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(String(row.completed_at)).toISOString()
  };
}

/** @param {{limit?: unknown, cursor?: unknown}} [input] */
export async function listCustomerSyncRuns(input = {}) {
  const limit = listLimit(input.limit);
  const after = cursor(input.cursor);
  const result = await query(
    `SELECT * FROM netsuite_customer_sync_runs
      WHERE ($1::timestamptz IS NULL OR (requested_at, run_id) < ($1::timestamptz, $2::uuid))
      ORDER BY requested_at DESC, run_id DESC
      LIMIT $3`,
    [after?.[0] || null, after?.[1] || null, limit + 1]
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    schemaVersion: "mbt-customer-sync-runs-v1",
    items: rows.map(publicRun),
    nextCursor: result.rows.length > limit && last
      ? encodeCursor(last.requested_at, last.run_id)
      : null
  };
}

/** @param {string} runId */
export async function getCustomerSyncRun(runId) {
  const id = requiredText(runId, "Customer sync run ID");
  const result = await query("SELECT * FROM netsuite_customer_sync_runs WHERE run_id = $1::uuid", [id]);
  if (!result.rowCount) {
    throw failure(404, "MBT_CUSTOMER_SYNC_RUN_NOT_FOUND", "The customer sync run was not found.");
  }
  return { schemaVersion: "mbt-customer-sync-run-v1", ...publicRun(result.rows[0]) };
}

/** @param {Record<string, unknown>} row */
function publicConflict(row) {
  return {
    conflictId: String(row.conflict_id),
    runId: String(row.run_id),
    entityType: String(row.entity_type),
    customerNetSuiteId: row.customer_netsuite_id === null ? null : String(row.customer_netsuite_id),
    externalId: String(row.external_id),
    currentSourceModifiedAt: row.current_source_modified_at === null
      ? null
      : new Date(String(row.current_source_modified_at)).toISOString(),
    incomingSourceModifiedAt: new Date(String(row.incoming_source_modified_at)).toISOString(),
    currentSnapshot: row.current_snapshot,
    incomingSnapshot: row.incoming_snapshot,
    status: String(row.status),
    resolutionNote: row.resolution_note === null ? null : String(row.resolution_note),
    resolvedBy: row.resolved_by === null ? null : String(row.resolved_by),
    resolvedAt: row.resolved_at === null ? null : new Date(String(row.resolved_at)).toISOString(),
    revision: Number(row.revision),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

/** @param {{status?: unknown, limit?: unknown, cursor?: unknown}} [input] */
export async function listCustomerConflicts(input = {}) {
  const status = String(input.status || "open").trim().toLowerCase();
  if (!new Set(["open", "resolved_current", "resolved_incoming", "ignored", "all"]).has(status)) {
    throw failure(400, "MBT_CUSTOMER_CONFLICT_STATUS_INVALID", "The conflict status filter is invalid.");
  }
  const limit = listLimit(input.limit);
  const after = cursor(input.cursor);
  const result = await query(
    `SELECT * FROM netsuite_customer_sync_conflicts
      WHERE ($1 = 'all' OR status = $1)
        AND ($2::timestamptz IS NULL OR (created_at, conflict_id) > ($2::timestamptz, $3::uuid))
      ORDER BY created_at, conflict_id
      LIMIT $4`,
    [status, after?.[0] || null, after?.[1] || null, limit + 1]
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    schemaVersion: "mbt-customer-conflicts-v1",
    items: rows.map(publicConflict),
    nextCursor: result.rows.length > limit && last
      ? encodeCursor(last.created_at, last.conflict_id)
      : null
  };
}

/**
 * @param {object} input
 * @param {import("./audit-repository.js").MbtActor} input.actor
 * @param {string} input.conflictId
 * @param {unknown} input.decision
 * @param {number} input.expectedRevision
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function resolveCustomerConflict(input) {
  const conflictId = requiredText(input.conflictId, "Customer conflict ID");
  const reason = requiredText(input.reason, "Customer conflict audit reason");
  const decision = String(input.decision || "");
  const status = ({
    keep_current: "resolved_current",
    accept_incoming: "resolved_incoming",
    ignore: "ignored"
  })[decision];
  if (!status || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw failure(400, "MBT_CUSTOMER_CONFLICT_INPUT_INVALID", "A decision and positive expected revision are required.");
  }
  return executeMbtCommand({
    actor: input.actor,
    commandName: "mbt.customer.conflict.resolve",
    idempotencyKey: input.idempotencyKey,
    payload: { conflictId, decision, expectedRevision: input.expectedRevision, reason },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const selected = await query(
        "SELECT * FROM netsuite_customer_sync_conflicts WHERE conflict_id = $1::uuid FOR UPDATE",
        [conflictId]
      );
      if (!selected.rowCount) {
        throw failure(404, "MBT_CUSTOMER_CONFLICT_NOT_FOUND", "The customer conflict was not found.");
      }
      const before = publicConflict(selected.rows[0]);
      if (before.status !== "open") {
        throw failure(409, "MBT_CUSTOMER_CONFLICT_RESOLVED", "The customer conflict is already resolved.");
      }
      if (before.revision !== input.expectedRevision) {
        throw failure(409, "MBT_STALE_REVISION", "The customer conflict changed. Refresh and try again.");
      }
      const updated = await query(
        `UPDATE netsuite_customer_sync_conflicts
            SET status = $2, resolution_note = $3, resolved_by = $4,
                resolved_at = now(), revision = revision + 1, updated_at = now()
          WHERE conflict_id = $1::uuid
          RETURNING *`,
        [conflictId, status, reason, input.actor.operatorId]
      );
      const after = publicConflict(updated.rows[0]);
      return {
        status: 200,
        body: { schemaVersion: "mbt-customer-conflict-v1", conflict: after },
        audit: {
          action: "mbt.customer.conflict.resolved",
          entityType: "customer_sync_conflict",
          entityId: conflictId,
          beforeState: before,
          afterState: after,
          reason,
          revisionBefore: before.revision,
          revisionAfter: after.revision,
          source: "customer_sync"
        }
      };
    }
  });
}

/** @param {{query?: unknown, limit?: unknown, cursor?: unknown}} [input] */
export async function searchCustomers(input = {}) {
  const search = String(input.query || "").trim();
  if (search.length < 2) {
    throw failure(400, "MBT_CUSTOMER_SEARCH_INVALID", "Enter at least two characters to search customers.");
  }
  const limit = listLimit(input.limit, 25);
  const after = cursor(input.cursor);
  const result = await query(
    `SELECT netsuite_id::text, entity_number, legal_name, display_name, currency,
            terms, tax_status, credit_status, email, phone, source_modified_at
       FROM netsuite_customers
      WHERE active
        AND (entity_number ILIKE '%' || $1 || '%'
          OR legal_name ILIKE '%' || $1 || '%'
          OR display_name ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR (lower(display_name), netsuite_id) > ($2::text, $3::bigint))
      ORDER BY lower(display_name), netsuite_id
      LIMIT $4`,
    [search, after?.[0] || null, after?.[1] || null, limit + 1]
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    schemaVersion: "mbt-customers-v1",
    items: rows.map((/** @type {Record<string, unknown>} */ row) => ({
      customerNetSuiteId: String(row.netsuite_id),
      entityNumber: String(row.entity_number),
      legalName: String(row.legal_name),
      displayName: String(row.display_name),
      currency: String(row.currency),
      terms: row.terms === null ? null : String(row.terms),
      taxStatus: row.tax_status === null ? null : String(row.tax_status),
      creditStatus: row.credit_status === null ? null : String(row.credit_status),
      email: String(row.email || ""),
      phone: String(row.phone || ""),
      sourceModifiedAt: new Date(String(row.source_modified_at)).toISOString()
    })),
    nextCursor: result.rows.length > limit && last
      ? encodeCursor(String(last.display_name).toLowerCase(), last.netsuite_id)
      : null
  };
}

/**
 * The live NetSuite reader is intentionally supplied at deployment/pilot time;
 * implementation tests must not invoke live customer data.
 * @param {Record<string, unknown>} _input
 * @returns {Promise<{status: number, replayed: boolean, body: Record<string, unknown>}>}
 */
export async function startCustomerSync(_input) {
  throw failure(
    503,
    "MBT_CUSTOMER_SOURCE_NOT_CONFIGURED",
    "The read-only customer source is not configured for this environment. Use the approved export import path."
  );
}

export const customerOperationsService = Object.freeze({
  startCustomerSync,
  listCustomerSyncRuns,
  getCustomerSyncRun,
  listCustomerConflicts,
  resolveCustomerConflict,
  searchCustomers
});
