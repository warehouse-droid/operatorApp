// @ts-check

import crypto from "node:crypto";

import { query, withTransaction } from "../db.js";
import { canonicalSha256 } from "./canonical-json.js";
import { MbtError } from "./errors.js";
import { assertOutboxTransition } from "./outbox-state.js";

const OUTBOX_COLUMNS = `
  outbox_id,
  external_idempotency_key,
  operation_type,
  target_record_type,
  payload,
  payload_hash,
  billing_version_id,
  sales_order_chain_id,
  deposit_record_id,
  parent_outbox_id,
  state,
  attempt_count,
  next_attempt_at,
  lease_token,
  lease_owner,
  lease_acquired_at,
  lease_expires_at,
  sent_at,
  external_acknowledged_at,
  lookup_required,
  netsuite_id,
  netsuite_reference,
  response_snapshot,
  error_code,
  error_message,
  attention_reason,
  posted_at,
  reconciled_at,
  created_at,
  updated_at`;

/** @param {string} alias */
function qualifiedOutboxColumns(alias) {
  return OUTBOX_COLUMNS.trim().split(",")
    .map((column) => `${alias}.${column.trim()}`)
    .join(", ");
}

const QUALIFIED_OUTBOX_COLUMNS = qualifiedOutboxColumns("o");

/**
 * @typedef {object} EnqueueInput
 * @property {string} externalIdempotencyKey
 * @property {string} operationType
 * @property {string} targetRecordType
 * @property {Record<string, unknown>} payload
 * @property {string | null} [billingVersionId]
 * @property {string | null} [salesOrderChainId]
 * @property {string | null} [depositRecordId]
 * @property {string | null} [parentOutboxId]
 * @property {string | Date} [nextAttemptAt]
 * @property {() => Promise<void>} [businessMutation]
 */

/**
 * @typedef {object} OutboxIdentity
 * @property {string} externalIdempotencyKey
 * @property {string} operationType
 * @property {string} targetRecordType
 * @property {Record<string, unknown>} payload
 * @property {string} payloadHash
 * @property {string | null} billingVersionId
 * @property {string | null} salesOrderChainId
 * @property {string | null} depositRecordId
 * @property {string | null} parentOutboxId
 * @property {string} nextAttemptAt
 */

/**
 * @typedef {object} AttemptInput
 * @property {Record<string, unknown>} leased
 * @property {string} workerId
 * @property {string} leaseToken
 * @property {string} stage
 * @property {string} outcome
 * @property {Record<string, unknown> | null} responseSnapshot
 * @property {number | null} netsuiteId
 * @property {string | null} netsuiteReference
 * @property {string | null} sentAt
 * @property {string | null} externalAcknowledgedAt
 * @property {string | null} errorCode
 * @property {string | null} errorMessage
 */

/**
 * @typedef {object} LookupContext
 * @property {string} recordType
 * @property {string} externalId
 * @property {Record<string, unknown>} payload
 * @property {string} payloadHash
 */

/**
 * @typedef {object} LookupFound
 * @property {"found"} status
 * @property {number} netsuiteId
 * @property {string} netsuiteReference
 * @property {Record<string, unknown>} responseSnapshot
 */

/**
 * @typedef {object} LookupAbsent
 * @property {"definitively_absent"} status
 * @property {Record<string, unknown>} [responseSnapshot]
 */

/** @typedef {LookupFound | LookupAbsent} LookupResult */

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError(`An outbox ${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new TypeError(`A positive integer ${label} is required.`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function timestamp(value, label) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`A valid ${label} timestamp is required.`);
  }
  return date.toISOString();
}

/** @param {unknown} value */
function optionalUuid(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

/** @param {Record<string, unknown>} row */
function outboxRow(row) {
  return {
    outboxId: String(row.outbox_id),
    externalIdempotencyKey: String(row.external_idempotency_key),
    operationType: String(row.operation_type),
    targetRecordType: String(row.target_record_type),
    payload: row.payload,
    payloadHash: String(row.payload_hash),
    billingVersionId: row.billing_version_id,
    salesOrderChainId: row.sales_order_chain_id,
    depositRecordId: row.deposit_record_id,
    parentOutboxId: row.parent_outbox_id,
    state: String(row.state),
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at,
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner,
    leaseAcquiredAt: row.lease_acquired_at,
    leaseExpiresAt: row.lease_expires_at,
    sentAt: row.sent_at,
    externalAcknowledgedAt: row.external_acknowledged_at,
    lookupRequired: row.lookup_required === true,
    netsuiteId: row.netsuite_id === null ? null : Number(row.netsuite_id),
    netsuiteReference: row.netsuite_reference,
    responseSnapshot: row.response_snapshot,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attentionReason: row.attention_reason,
    postedAt: row.posted_at,
    reconciledAt: row.reconciled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** @param {Record<string, unknown>} payload */
function assertPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("An outbox payload object is required.");
  }
  return payload;
}

/** @param {Record<string, unknown>} row @param {OutboxIdentity} identity */
function sameIdentity(row, identity) {
  return row.operation_type === identity.operationType
    && row.target_record_type === identity.targetRecordType
    && row.payload_hash === identity.payloadHash
    && optionalUuid(row.billing_version_id) === identity.billingVersionId
    && optionalUuid(row.sales_order_chain_id) === identity.salesOrderChainId
    && optionalUuid(row.deposit_record_id) === identity.depositRecordId
    && optionalUuid(row.parent_outbox_id) === identity.parentOutboxId;
}

/** @param {Record<string, unknown>} row @param {OutboxIdentity} identity */
function assertSameIdentity(row, identity) {
  if (sameIdentity(row, identity)) {
    return;
  }
  throw new MbtError(/** @type {any} */ ({
    status: 409,
    code: "MBT_OUTBOX_IDENTITY_CONFLICT",
    message: "The external idempotency identity is already bound to different outbox work."
  }));
}

/** @param {EnqueueInput} input @returns {OutboxIdentity} */
function enqueueIdentity(input) {
  const payload = assertPayload(input.payload);
  return {
    externalIdempotencyKey: requiredText(input.externalIdempotencyKey, "external idempotency key"),
    operationType: requiredText(input.operationType, "operation type"),
    targetRecordType: requiredText(input.targetRecordType, "target record type"),
    payload,
    payloadHash: canonicalSha256(payload),
    billingVersionId: optionalUuid(input.billingVersionId),
    salesOrderChainId: optionalUuid(input.salesOrderChainId),
    depositRecordId: optionalUuid(input.depositRecordId),
    parentOutboxId: optionalUuid(input.parentOutboxId),
    nextAttemptAt: input.nextAttemptAt === undefined
      ? new Date().toISOString()
      : timestamp(input.nextAttemptAt, "next attempt")
  };
}

/**
 * Atomically perform optional business work and enqueue one stable external
 * identity. Exact retries return the existing row without repeating business
 * mutation.
 *
 * @param {EnqueueInput} input
 */
export async function enqueueNetSuiteOutbox(input) {
  const identity = enqueueIdentity(input);
  const businessMutation = input.businessMutation;
  if (businessMutation !== undefined && typeof businessMutation !== "function") {
    throw new TypeError("An outbox business mutation must be a function.");
  }
  return withTransaction(async () => {
    await query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [identity.externalIdempotencyKey]
    );
    const existing = await query(
      `SELECT ${OUTBOX_COLUMNS}
         FROM mbt_netsuite_outbox
        WHERE external_idempotency_key = $1`,
      [identity.externalIdempotencyKey]
    );
    if (existing.rowCount) {
      assertSameIdentity(existing.rows[0], identity);
      return { outbox: outboxRow(existing.rows[0]), replayed: true };
    }
    if (businessMutation) {
      await businessMutation();
    }
    const inserted = await query(
      `INSERT INTO mbt_netsuite_outbox (
         outbox_id, external_idempotency_key, operation_type,
         target_record_type, payload, payload_hash, billing_version_id,
         sales_order_chain_id, deposit_record_id, parent_outbox_id,
         next_attempt_at
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11
       )
       RETURNING ${OUTBOX_COLUMNS}`,
      [
        crypto.randomUUID(),
        identity.externalIdempotencyKey,
        identity.operationType,
        identity.targetRecordType,
        JSON.stringify(identity.payload),
        identity.payloadHash,
        identity.billingVersionId,
        identity.salesOrderChainId,
        identity.depositRecordId,
        identity.parentOutboxId,
        identity.nextAttemptAt
      ]
    );
    return { outbox: outboxRow(inserted.rows[0]), replayed: false };
  });
}

/**
 * Claim one eligible event in a short transaction. No adapter or network work
 * is accepted by this API.
 *
 * @param {object} input
 * @param {string} input.workerId
 * @param {number} [input.leaseSeconds]
 */
export async function claimNextNetSuiteOutbox({ workerId, leaseSeconds = 30 }) {
  const normalizedWorkerId = requiredText(workerId, "worker ID");
  const normalizedLeaseSeconds = positiveInteger(leaseSeconds, "lease duration");
  const leaseToken = crypto.randomUUID();
  return withTransaction(async () => {
    const result = await query(
      `WITH candidate AS (
         SELECT o.outbox_id
           FROM mbt_netsuite_outbox o
          WHERE o.state = 'pending'
            AND o.next_attempt_at <= now()
            AND (
              o.parent_outbox_id IS NULL
              OR EXISTS (
                SELECT 1
                  FROM mbt_netsuite_outbox parent
                 WHERE parent.outbox_id = o.parent_outbox_id
                   AND parent.state IN ('sent', 'reconciled')
              )
            )
          ORDER BY o.next_attempt_at, o.created_at, o.outbox_id
          FOR UPDATE OF o SKIP LOCKED
          LIMIT 1
       )
       UPDATE mbt_netsuite_outbox o
          SET state = 'leased',
              attempt_count = o.attempt_count + 1,
              lease_token = $1,
              lease_owner = $2,
              lease_acquired_at = clock_timestamp(),
              lease_expires_at = clock_timestamp() + ($3 * interval '1 second'),
              updated_at = clock_timestamp()
         FROM candidate
        WHERE o.outbox_id = candidate.outbox_id
       RETURNING ${QUALIFIED_OUTBOX_COLUMNS}`,
      [leaseToken, normalizedWorkerId, normalizedLeaseSeconds]
    );
    return result.rowCount ? outboxRow(result.rows[0]) : null;
  });
}

/** @param {string} outboxId @param {string} leaseToken @param {string} workerId */
async function lockedLease(outboxId, leaseToken, workerId) {
  const result = await query(
    `SELECT ${OUTBOX_COLUMNS}
       FROM mbt_netsuite_outbox
      WHERE outbox_id = $1
      FOR UPDATE`,
    [outboxId]
  );
  const row = result.rows[0];
  if (!row
    || row.state !== "leased"
    || String(row.lease_token) !== leaseToken
    || row.lease_owner !== workerId) {
    throw new MbtError(/** @type {any} */ ({
      status: 409,
      code: "MBT_OUTBOX_LEASE_LOST",
      message: "The NetSuite outbox lease is no longer owned by this worker."
    }));
  }
  return row;
}

/**
 * @param {object} input
 * @param {string} input.outboxId
 * @param {string} input.leaseToken
 * @param {string} input.workerId
 * @param {string | Date} input.sentAt
 */
export async function markNetSuiteOutboxSendStarted({
  outboxId,
  leaseToken,
  workerId,
  sentAt
}) {
  const normalizedOutboxId = requiredText(outboxId, "ID");
  const normalizedLeaseToken = requiredText(leaseToken, "lease token");
  const normalizedWorkerId = requiredText(workerId, "worker ID");
  const normalizedSentAt = timestamp(sentAt, "sent-at");
  return withTransaction(async () => {
    await lockedLease(normalizedOutboxId, normalizedLeaseToken, normalizedWorkerId);
    const result = await query(
      `UPDATE mbt_netsuite_outbox
          SET sent_at = $2,
              lookup_required = true,
              updated_at = clock_timestamp()
        WHERE outbox_id = $1
       RETURNING ${OUTBOX_COLUMNS}`,
      [normalizedOutboxId, normalizedSentAt]
    );
    return outboxRow(result.rows[0]);
  });
}

/**
 * @param {object} input
 * @param {string} input.outboxId
 * @param {string} input.leaseToken
 * @param {string} input.workerId
 * @param {string | Date} input.sentAt
 * @param {string | Date | null | undefined} input.externalAcknowledgedAt
 * @param {number} input.netsuiteId
 * @param {string} input.netsuiteReference
 * @param {Record<string, unknown>} input.responseSnapshot
 */
export async function markNetSuiteOutboxSent({
  outboxId,
  leaseToken,
  workerId,
  sentAt,
  externalAcknowledgedAt,
  netsuiteId,
  netsuiteReference,
  responseSnapshot
}) {
  const transitionAcknowledgement = externalAcknowledgedAt === null
    || externalAcknowledgedAt === undefined
    ? null
    : String(externalAcknowledgedAt);
  assertOutboxTransition("leased", "sent", {
    externalAcknowledgedAt: transitionAcknowledgement
  });
  const normalizedOutboxId = requiredText(outboxId, "ID");
  const normalizedLeaseToken = requiredText(leaseToken, "lease token");
  const normalizedWorkerId = requiredText(workerId, "worker ID");
  const normalizedSentAt = timestamp(sentAt, "sent-at");
  const normalizedAcknowledgedAt = timestamp(externalAcknowledgedAt, "external acknowledgement");
  const normalizedNetSuiteId = positiveInteger(netsuiteId, "NetSuite ID");
  const normalizedReference = requiredText(netsuiteReference, "NetSuite reference");
  assertPayload(responseSnapshot);
  return withTransaction(async () => {
    const leased = await lockedLease(normalizedOutboxId, normalizedLeaseToken, normalizedWorkerId);
    await insertAttempt({
      leased,
      workerId: normalizedWorkerId,
      leaseToken: normalizedLeaseToken,
      stage: "send",
      outcome: "succeeded",
      responseSnapshot,
      netsuiteId: normalizedNetSuiteId,
      netsuiteReference: normalizedReference,
      sentAt: normalizedSentAt,
      externalAcknowledgedAt: normalizedAcknowledgedAt,
      errorCode: null,
      errorMessage: null
    });
    const result = await query(
      `UPDATE mbt_netsuite_outbox
          SET state = 'sent',
              lease_token = NULL,
              lease_owner = NULL,
              lease_acquired_at = NULL,
              lease_expires_at = NULL,
              sent_at = $2,
              external_acknowledged_at = $3,
              lookup_required = false,
              netsuite_id = $4,
              netsuite_reference = $5,
              response_snapshot = $6::jsonb,
              error_code = NULL,
              error_message = NULL,
              attention_reason = NULL,
              posted_at = $3,
              updated_at = clock_timestamp()
        WHERE outbox_id = $1
       RETURNING ${OUTBOX_COLUMNS}`,
      [
        normalizedOutboxId,
        normalizedSentAt,
        normalizedAcknowledgedAt,
        normalizedNetSuiteId,
        normalizedReference,
        JSON.stringify(responseSnapshot)
      ]
    );
    return outboxRow(result.rows[0]);
  });
}

/** @param {AttemptInput} input */
async function insertAttempt({
  leased,
  workerId,
  leaseToken,
  stage,
  outcome,
  responseSnapshot,
  netsuiteId,
  netsuiteReference,
  sentAt,
  externalAcknowledgedAt,
  errorCode,
  errorMessage
}) {
  await query(
    `INSERT INTO mbt_netsuite_outbox_attempts (
       outbox_attempt_id, outbox_id, attempt_number, worker_id,
       lease_token, attempt_stage, outcome, request_payload_hash,
       response_snapshot, netsuite_id, netsuite_reference,
       error_code, error_message, started_at, sent_at,
       external_acknowledged_at, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9::jsonb, $10, $11, $12, $13, $14, $15, $16, clock_timestamp()
     )`,
    [
      crypto.randomUUID(),
      leased.outbox_id,
      Number(leased.attempt_count),
      workerId,
      leaseToken,
      stage,
      outcome,
      leased.payload_hash,
      responseSnapshot === null ? null : JSON.stringify(responseSnapshot),
      netsuiteId,
      netsuiteReference,
      errorCode,
      errorMessage,
      leased.lease_acquired_at,
      sentAt,
      externalAcknowledgedAt
    ]
  );
}

/**
 * @param {object} input
 * @param {string} input.outboxId
 * @param {string} input.leaseToken
 * @param {string} input.workerId
 * @param {string} input.errorCode
 * @param {string} input.errorMessage
 * @param {string | Date} [input.retryAt]
 * @param {string | Date} [input.sentAt]
 */
export async function recordNetSuiteOutboxFailure({
  outboxId,
  leaseToken,
  workerId,
  errorCode,
  errorMessage,
  retryAt = new Date(),
  sentAt
}) {
  const normalizedOutboxId = requiredText(outboxId, "ID");
  const normalizedLeaseToken = requiredText(leaseToken, "lease token");
  const normalizedWorkerId = requiredText(workerId, "worker ID");
  const normalizedErrorCode = requiredText(errorCode, "failure code");
  const normalizedErrorMessage = String(errorMessage ?? "");
  const normalizedRetryAt = timestamp(retryAt, "retry-at");
  const normalizedSentAt = sentAt === undefined ? null : timestamp(sentAt, "sent-at");
  return withTransaction(async () => {
    const leased = await lockedLease(normalizedOutboxId, normalizedLeaseToken, normalizedWorkerId);
    const storedSentAt = leased.sent_at === null
      ? null
      : timestamp(leased.sent_at, "stored sent-at");
    const effectiveSentAt = normalizedSentAt || storedSentAt;
    const uncertain = effectiveSentAt !== null;
    await insertAttempt({
      leased,
      workerId: normalizedWorkerId,
      leaseToken: normalizedLeaseToken,
      stage: "send",
      outcome: uncertain ? "uncertain" : "definitive_failure",
      responseSnapshot: null,
      netsuiteId: null,
      netsuiteReference: null,
      sentAt: effectiveSentAt,
      externalAcknowledgedAt: null,
      errorCode: normalizedErrorCode,
      errorMessage: normalizedErrorMessage
    });
    const result = await query(
      `UPDATE mbt_netsuite_outbox
          SET state = $2,
              lease_token = NULL,
              lease_owner = NULL,
              lease_acquired_at = NULL,
              lease_expires_at = NULL,
              next_attempt_at = $3,
              sent_at = COALESCE($4, sent_at),
              lookup_required = $5,
              error_code = $6,
              error_message = $7,
              attention_reason = $8,
              updated_at = clock_timestamp()
        WHERE outbox_id = $1
       RETURNING ${OUTBOX_COLUMNS}`,
      [
        normalizedOutboxId,
        uncertain ? "attention" : "pending",
        normalizedRetryAt,
        effectiveSentAt,
        uncertain,
        normalizedErrorCode,
        normalizedErrorMessage,
        uncertain ? "external_outcome_uncertain" : null
      ]
    );
    return outboxRow(result.rows[0]);
  });
}

/**
 * @param {object} [input]
 * @param {number} [input.limit]
 */
export async function recoverExpiredNetSuiteOutboxLeases({ limit = 100 } = {}) {
  const normalizedLimit = positiveInteger(limit, "recovery limit");
  return withTransaction(async () => {
    const result = await query(
      `WITH expired AS (
         SELECT outbox_id, sent_at
           FROM mbt_netsuite_outbox
          WHERE state = 'leased'
            AND lease_expires_at < now()
          ORDER BY lease_expires_at, outbox_id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE mbt_netsuite_outbox o
          SET state = CASE WHEN expired.sent_at IS NULL THEN 'pending' ELSE 'attention' END,
              lease_token = NULL,
              lease_owner = NULL,
              lease_acquired_at = NULL,
              lease_expires_at = NULL,
              next_attempt_at = CASE WHEN expired.sent_at IS NULL THEN now() ELSE o.next_attempt_at END,
              lookup_required = expired.sent_at IS NOT NULL,
              attention_reason = CASE
                WHEN expired.sent_at IS NULL THEN NULL
                ELSE 'external_outcome_uncertain'
              END,
              updated_at = clock_timestamp()
         FROM expired
        WHERE o.outbox_id = expired.outbox_id
       RETURNING ${QUALIFIED_OUTBOX_COLUMNS}`,
      [normalizedLimit]
    );
    return result.rows.map(outboxRow);
  });
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function lookupObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A verifiable NetSuite external-ID lookup result is required.");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @returns {LookupResult} */
function normalizeLookupResult(value) {
  const candidate = lookupObject(value);
  const status = String(candidate.status || "").trim();
  if (status === "found") {
    const responseSnapshot = lookupObject(candidate.responseSnapshot);
    return {
      status,
      netsuiteId: positiveInteger(candidate.netsuiteId, "NetSuite ID"),
      netsuiteReference: requiredText(candidate.netsuiteReference, "NetSuite reference"),
      responseSnapshot
    };
  }
  if (status === "definitively_absent") {
    return {
      status,
      responseSnapshot: candidate.responseSnapshot === undefined
        ? { status }
        : lookupObject(candidate.responseSnapshot)
    };
  }
  throw new TypeError("The NetSuite lookup must report found or definitively_absent.");
}

/** @param {unknown} error */
function lookupFailure(error) {
  const candidate = /** @type {{code?: unknown, message?: unknown}} */ (error);
  const errorCode = String(candidate?.code || "NETSUITE_LOOKUP_UNABLE_TO_VERIFY").trim()
    || "NETSUITE_LOOKUP_UNABLE_TO_VERIFY";
  const errorMessage = String(candidate?.message || "The NetSuite external-ID lookup could not be verified.").trim()
    || "The NetSuite external-ID lookup could not be verified.";
  return { errorCode, errorMessage };
}

/**
 * Acquire a short lookup-only lease. Network work happens only after this
 * transaction commits.
 *
 * @param {string} outboxId
 * @param {string} workerId
 * @param {string} leaseToken
 * @param {number} leaseSeconds
 */
async function leaseUncertainCreateLookup(outboxId, workerId, leaseToken, leaseSeconds) {
  return withTransaction(async () => {
    const result = await query(
      `UPDATE mbt_netsuite_outbox
          SET state = 'leased',
              attempt_count = attempt_count + 1,
              lease_token = $2,
              lease_owner = $3,
              lease_acquired_at = clock_timestamp(),
              lease_expires_at = clock_timestamp() + ($4 * interval '1 second'),
              updated_at = clock_timestamp()
        WHERE outbox_id = $1
          AND state = 'attention'
          AND lookup_required
          AND operation_type IN ('create_sales_order', 'create_customer_deposit')
      RETURNING ${OUTBOX_COLUMNS}`,
      [outboxId, leaseToken, workerId, leaseSeconds]
    );
    if (result.rowCount) {
      return result.rows[0];
    }
    const existing = await query(
      `SELECT state, lookup_required, operation_type
         FROM mbt_netsuite_outbox
        WHERE outbox_id = $1`,
      [outboxId]
    );
    if (!existing.rowCount) {
      throw new MbtError(/** @type {any} */ ({
        status: 404,
        code: "MBT_OUTBOX_NOT_FOUND",
        message: "The NetSuite outbox event was not found."
      }));
    }
    throw new MbtError(/** @type {any} */ ({
      status: 409,
      code: "MBT_OUTBOX_LOOKUP_NOT_REQUIRED",
      message: "This outbox event is not an uncertain create awaiting external-ID lookup."
    }));
  });
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} input.leased
 * @param {string} input.status
 * @param {Record<string, unknown> | null} input.actualSnapshot
 * @param {Record<string, unknown>} input.differenceSnapshot
 * @param {number | null} input.netsuiteId
 * @param {string | null} input.netsuiteReference
 * @param {string | null} input.unableToVerifyReason
 */
async function insertLookupReconciliation({
  leased,
  status,
  actualSnapshot,
  differenceSnapshot,
  netsuiteId,
  netsuiteReference,
  unableToVerifyReason
}) {
  await query(
    `INSERT INTO mbt_netsuite_reconciliations (
       reconciliation_id, outbox_id, netsuite_record_type,
       netsuite_id, netsuite_reference, expected_snapshot,
       actual_snapshot, difference_snapshot, status,
       unable_to_verify_reason, checked_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6::jsonb,
       $7::jsonb, $8::jsonb, $9, $10, clock_timestamp()
     )`,
    [
      crypto.randomUUID(),
      leased.outbox_id,
      leased.target_record_type,
      netsuiteId,
      netsuiteReference,
      JSON.stringify(leased.payload),
      actualSnapshot === null ? null : JSON.stringify(actualSnapshot),
      JSON.stringify(differenceSnapshot),
      status,
      unableToVerifyReason
    ]
  );
}

/**
 * Resolve an uncertain create only by an injected read-only external-ID
 * lookup. A found record is reconciled without another create. Only an
 * explicit definitive absence returns the original event to the send queue.
 * Lookup failures remain in attention.
 *
 * @param {object} input
 * @param {string} input.outboxId
 * @param {string} input.workerId
 * @param {(context: LookupContext) => Promise<LookupResult>} input.lookupByExternalId
 * @param {number} [input.leaseSeconds]
 * @param {string | Date} [input.retryAt]
 */
export async function resolveUncertainNetSuiteCreate({
  outboxId,
  workerId,
  lookupByExternalId,
  leaseSeconds = 30,
  retryAt = new Date()
}) {
  const normalizedOutboxId = requiredText(outboxId, "ID");
  const normalizedWorkerId = requiredText(workerId, "worker ID");
  const normalizedLeaseSeconds = positiveInteger(leaseSeconds, "lease duration");
  const normalizedRetryAt = timestamp(retryAt, "retry-at");
  if (typeof lookupByExternalId !== "function") {
    throw new TypeError("A read-only NetSuite external-ID lookup is required.");
  }
  const leaseToken = crypto.randomUUID();
  const leased = await leaseUncertainCreateLookup(
    normalizedOutboxId,
    normalizedWorkerId,
    leaseToken,
    normalizedLeaseSeconds
  );

  /** @type {LookupResult | null} */
  let lookupResult = null;
  /** @type {{errorCode: string, errorMessage: string} | null} */
  let failure = null;
  try {
    const payload = lookupObject(leased.payload);
    const externalId = requiredText(payload.externalId, "external ID");
    lookupResult = normalizeLookupResult(await lookupByExternalId({
      recordType: String(leased.target_record_type),
      externalId,
      payload,
      payloadHash: String(leased.payload_hash)
    }));
  } catch (error) {
    failure = lookupFailure(error);
  }

  return withTransaction(async () => {
    const locked = await lockedLease(normalizedOutboxId, leaseToken, normalizedWorkerId);
    if (locked.lookup_required !== true || locked.sent_at === null) {
      throw new MbtError(/** @type {any} */ ({
        status: 409,
        code: "MBT_OUTBOX_LOOKUP_NOT_REQUIRED",
        message: "The uncertain-create lookup is no longer required."
      }));
    }

    if (failure) {
      await insertAttempt({
        leased: locked,
        workerId: normalizedWorkerId,
        leaseToken,
        stage: "lookup",
        outcome: "uncertain",
        responseSnapshot: null,
        netsuiteId: null,
        netsuiteReference: null,
        sentAt: null,
        externalAcknowledgedAt: null,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage
      });
      await insertLookupReconciliation({
        leased: locked,
        status: "unable_to_verify",
        actualSnapshot: null,
        differenceSnapshot: { lookup: "unable_to_verify" },
        netsuiteId: null,
        netsuiteReference: null,
        unableToVerifyReason: failure.errorMessage
      });
      const result = await query(
        `UPDATE mbt_netsuite_outbox
            SET state = 'attention',
                lease_token = NULL,
                lease_owner = NULL,
                lease_acquired_at = NULL,
                lease_expires_at = NULL,
                lookup_required = true,
                error_code = $2,
                error_message = $3,
                attention_reason = 'external_lookup_unable_to_verify',
                updated_at = clock_timestamp()
          WHERE outbox_id = $1
        RETURNING ${OUTBOX_COLUMNS}`,
        [normalizedOutboxId, failure.errorCode, failure.errorMessage]
      );
      return {
        resolution: "unable_to_verify",
        replayed: false,
        outbox: outboxRow(result.rows[0])
      };
    }

    const verified = /** @type {LookupResult} */ (lookupResult);
    if (verified.status === "found") {
      const acknowledgedAt = new Date().toISOString();
      await insertAttempt({
        leased: locked,
        workerId: normalizedWorkerId,
        leaseToken,
        stage: "lookup",
        outcome: "succeeded",
        responseSnapshot: verified.responseSnapshot,
        netsuiteId: verified.netsuiteId,
        netsuiteReference: verified.netsuiteReference,
        sentAt: null,
        externalAcknowledgedAt: null,
        errorCode: null,
        errorMessage: null
      });
      await insertLookupReconciliation({
        leased: locked,
        status: "matched",
        actualSnapshot: verified.responseSnapshot,
        differenceSnapshot: {},
        netsuiteId: verified.netsuiteId,
        netsuiteReference: verified.netsuiteReference,
        unableToVerifyReason: null
      });
      const result = await query(
        `UPDATE mbt_netsuite_outbox
            SET state = 'reconciled',
                lease_token = NULL,
                lease_owner = NULL,
                lease_acquired_at = NULL,
                lease_expires_at = NULL,
                external_acknowledged_at = $2,
                lookup_required = false,
                netsuite_id = $3,
                netsuite_reference = $4,
                response_snapshot = $5::jsonb,
                error_code = NULL,
                error_message = NULL,
                attention_reason = NULL,
                posted_at = COALESCE(posted_at, sent_at, $2),
                reconciled_at = $2,
                updated_at = clock_timestamp()
          WHERE outbox_id = $1
        RETURNING ${OUTBOX_COLUMNS}`,
        [
          normalizedOutboxId,
          acknowledgedAt,
          verified.netsuiteId,
          verified.netsuiteReference,
          JSON.stringify(verified.responseSnapshot)
        ]
      );
      return {
        resolution: "found",
        replayed: false,
        outbox: outboxRow(result.rows[0])
      };
    }

    await insertAttempt({
      leased: locked,
      workerId: normalizedWorkerId,
      leaseToken,
      stage: "lookup",
      outcome: "definitive_failure",
      responseSnapshot: verified.responseSnapshot || { status: verified.status },
      netsuiteId: null,
      netsuiteReference: null,
      sentAt: null,
      externalAcknowledgedAt: null,
      errorCode: "NETSUITE_EXTERNAL_ID_ABSENT",
      errorMessage: "The external ID is definitively absent in NetSuite."
    });
    await insertLookupReconciliation({
      leased: locked,
      status: "different",
      actualSnapshot: null,
      differenceSnapshot: { externalRecord: "absent" },
      netsuiteId: null,
      netsuiteReference: null,
      unableToVerifyReason: null
    });
    const result = await query(
      `UPDATE mbt_netsuite_outbox
          SET state = 'pending',
              lease_token = NULL,
              lease_owner = NULL,
              lease_acquired_at = NULL,
              lease_expires_at = NULL,
              next_attempt_at = $2,
              sent_at = NULL,
              external_acknowledged_at = NULL,
              lookup_required = false,
              netsuite_id = NULL,
              netsuite_reference = NULL,
              response_snapshot = NULL,
              error_code = NULL,
              error_message = NULL,
              attention_reason = NULL,
              posted_at = NULL,
              reconciled_at = NULL,
              updated_at = clock_timestamp()
        WHERE outbox_id = $1
      RETURNING ${OUTBOX_COLUMNS}`,
      [normalizedOutboxId, normalizedRetryAt]
    );
    return {
      resolution: "definitively_absent",
      replayed: false,
      outbox: outboxRow(result.rows[0])
    };
  });
}
