// @ts-check

import { query, withTransaction } from "../db.js";
import { canonicalSha256, canonicalize } from "./canonical-json.js";
import { MbtError } from "./errors.js";
import { assertExpectedRevision, nextRevision } from "./revisions.js";

/**
 * @typedef {object} BillingApprovalInput
 * @property {string} billingCaseId
 * @property {number} expectedRevision
 * @property {string} rateCardVersionId
 * @property {Record<string, unknown>} calculationSnapshot
 * @property {Record<string, unknown>} sourceRevisionSnapshot
 * @property {number} subtotalMinor
 * @property {number} estimatedTaxMinor
 * @property {string} currency
 * @property {string} approvedBy
 * @property {string} approvalReason
 * @property {string} correlationId
 * @property {string} idempotencyKey
 * @property {Record<string, unknown>} [outboxPayload]
 */

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be text.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function uuid(value, label) {
  const normalized = requiredText(value, label).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function nonnegativeMinor(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer number of minor units.`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function objectSnapshot(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const snapshot = canonicalize(value);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (snapshot);
}

/** @param {unknown} value */
function currencyCode(value) {
  const normalized = requiredText(value, "Billing currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new TypeError("Billing currency must be a three-letter ISO code.");
  }
  return normalized;
}

/** @param {Record<string, unknown>} payload */
function assertNoExternalPayload(payload) {
  if (Reflect.ownKeys(payload).length === 0) {
    return;
  }
  throw new MbtError({
    status: 409,
    code: "MBT_LOCAL_POSTING_PAYLOAD_REFUSED",
    message: "Billing approval cannot include NetSuite work in the local-first phase."
  });
}

/** @param {unknown} value */
function storedPostingMode(value) {
  const normalized = String(value ?? "");
  if (normalized === "local_only" || normalized === "netsuite_future") {
    return normalized;
  }
  throw new TypeError("The stored billing posting mode is invalid.");
}

/** @param {string} hash */
function deterministicUuid(hash) {
  const value = hash.slice(0, 32).split("");
  value[12] = "5";
  value[16] = ((Number.parseInt(value[16] || "0", 16) & 0x3) | 0x8).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @param {unknown} rawInput @returns {BillingApprovalInput} */
function normalizeApprovalInput(rawInput) {
  const input = /** @type {Partial<BillingApprovalInput>} */ (objectSnapshot(rawInput, "Billing approval"));
  return {
    billingCaseId: uuid(input.billingCaseId, "Billing case ID"),
    expectedRevision: positiveInteger(input.expectedRevision, "Expected billing revision"),
    rateCardVersionId: uuid(input.rateCardVersionId, "Rate-card version ID"),
    calculationSnapshot: objectSnapshot(input.calculationSnapshot, "Calculation snapshot"),
    sourceRevisionSnapshot: objectSnapshot(input.sourceRevisionSnapshot, "Source revision snapshot"),
    subtotalMinor: nonnegativeMinor(input.subtotalMinor, "Billing subtotal"),
    estimatedTaxMinor: nonnegativeMinor(input.estimatedTaxMinor, "Estimated billing tax"),
    currency: currencyCode(input.currency),
    approvedBy: requiredText(input.approvedBy, "Billing approver"),
    approvalReason: requiredText(input.approvalReason, "Billing approval reason"),
    correlationId: requiredText(input.correlationId, "Billing correlation ID"),
    idempotencyKey: requiredText(input.idempotencyKey, "Billing idempotency key"),
    outboxPayload: input.outboxPayload === undefined
      ? {}
      : objectSnapshot(input.outboxPayload, "Billing outbox payload")
  };
}

/** @param {string} actual @param {string} expected */
function assertCurrency(actual, expected) {
  if (actual === expected) {
    return;
  }
  throw new MbtError({
    status: 409,
    code: "MBT_BILLING_CURRENCY_MISMATCH",
    message: "The billing approval currency does not match its case."
  });
}

/** @param {string} status */
function assertApprovableStatus(status) {
  if (status === "ready" || status === "in_review") {
    return;
  }
  throw new MbtError({
    status: 409,
    code: "MBT_BILLING_NOT_APPROVABLE",
    message: "The billing case is not ready for approval."
  });
}

/**
 * Bind an idempotency key to every immutable approval field so a retry cannot
 * silently change the decision even though this phase creates no outbox row.
 *
 * @param {Record<string, unknown>} stored
 * @param {BillingApprovalInput} input
 * @param {number} totalMinor
 * @param {string} postingMode
 */
function assertApprovalIdentity(stored, input, totalMinor, postingMode) {
  const requestedHash = canonicalSha256({
    rateCardVersionId: input.rateCardVersionId,
    calculationSnapshot: input.calculationSnapshot,
    sourceRevisionSnapshot: input.sourceRevisionSnapshot,
    subtotalMinor: input.subtotalMinor,
    estimatedTaxMinor: input.estimatedTaxMinor,
    totalMinor,
    currency: input.currency,
    postingMode,
    expectedRevision: input.expectedRevision,
    approvedBy: input.approvedBy,
    approvalReason: input.approvalReason,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey
  });
  const storedHash = canonicalSha256({
    rateCardVersionId: String(stored.rate_card_version_id),
    calculationSnapshot: stored.calculation_snapshot,
    sourceRevisionSnapshot: stored.source_revision_snapshot,
    subtotalMinor: Number(stored.subtotal_minor),
    estimatedTaxMinor: Number(stored.estimated_tax_minor),
    totalMinor: Number(stored.total_minor),
    currency: String(stored.currency),
    postingMode: String(stored.posting_mode),
    expectedRevision: Number(stored.billing_case_revision_before),
    approvedBy: String(stored.approved_by),
    approvalReason: String(stored.approval_reason),
    correlationId: String(stored.correlation_id),
    idempotencyKey: String(stored.idempotency_key)
  });
  if (requestedHash === storedHash) {
    return;
  }
  throw new MbtError({
    status: 409,
    code: "MBT_BILLING_APPROVAL_IDENTITY_CONFLICT",
    message: "The billing approval idempotency key is already bound to different approval evidence."
  });
}

/** @param {Record<string, unknown>} row */
function assertFinalApprovalRow(row) {
  if (String(row.billing_version_status) !== "approved") {
    throw new MbtError({
      status: 409,
      code: "MBT_BILLING_APPROVAL_NOT_FINAL",
      message: "The stored billing approval is not finalized."
    });
  }
  const revisionBefore = Number(row.billing_case_revision_before);
  if (!Number.isSafeInteger(revisionBefore) || revisionBefore < 1) {
    throw new MbtError({
      status: 409,
      code: "MBT_BILLING_APPROVAL_IDENTITY_INCOMPLETE",
      message: "The stored billing approval is missing immutable revision evidence."
    });
  }
}

/** @param {Record<string, unknown>} row @param {boolean} replayed */
function approvalResult(row, replayed) {
  assertFinalApprovalRow(row);
  return {
    billingVersionId: String(row.billing_version_id),
    versionNumber: Number(row.version_number),
    billingCaseStatus: "approved",
    billingCaseRevision: nextRevision(Number(row.billing_case_revision_before)),
    currentVersionNumber: Number(row.version_number),
    postingMode: storedPostingMode(row.posting_mode),
    outbox: null,
    replayed
  };
}

const APPROVAL_RESULT_COLUMNS = `
  v.billing_version_id,
  v.version_number,
  v.status AS billing_version_status,
  v.billing_case_revision_before,
  v.rate_card_version_id,
  v.calculation_snapshot,
  v.source_revision_snapshot,
  v.subtotal_minor,
  v.estimated_tax_minor,
  v.total_minor,
  v.currency,
  v.posting_mode,
  v.approved_by,
  v.approval_reason,
  v.correlation_id,
  v.idempotency_key`;

/**
 * Approve one immutable local-first billing version. Posting mode is frozen as
 * intent only; neither allowed mode creates a Sales Order chain or outbox row.
 *
 * @param {unknown} rawInput
 */
export async function approveMbtBillingCase(rawInput) {
  const input = normalizeApprovalInput(rawInput);
  assertNoExternalPayload(input.outboxPayload || {});
  const totalMinor = input.subtotalMinor + input.estimatedTaxMinor;
  if (!Number.isSafeInteger(totalMinor)) {
    throw new TypeError("Billing total must be a safe integer number of minor units.");
  }
  const billingVersionId = deterministicUuid(canonicalSha256({
    scope: "mbt.billing.version",
    billingCaseId: input.billingCaseId,
    idempotencyKey: input.idempotencyKey
  }));
  return withTransaction(async () => {
    const selected = await query(
      `SELECT billing_case_id, customer_netsuite_id, status, currency,
              posting_mode, current_version_number, revision
         FROM mbt_billing_cases
        WHERE billing_case_id = $1
        FOR UPDATE`,
      [input.billingCaseId]
    );
    if (!selected.rowCount) {
      throw new MbtError({
        status: 404,
        code: "MBT_BILLING_CASE_NOT_FOUND",
        message: "The billing case was not found."
      });
    }
    const billingCase = selected.rows[0];
    const postingMode = storedPostingMode(billingCase.posting_mode);
    const existing = await query(
      `SELECT ${APPROVAL_RESULT_COLUMNS}
         FROM mbt_billing_versions v
        WHERE v.billing_case_id = $1
          AND v.idempotency_key = $2`,
      [input.billingCaseId, input.idempotencyKey]
    );
    if (existing.rowCount) {
      assertFinalApprovalRow(existing.rows[0]);
      const existingPostingMode = storedPostingMode(existing.rows[0].posting_mode);
      assertApprovalIdentity(existing.rows[0], input, totalMinor, existingPostingMode);
      return approvalResult(existing.rows[0], true);
    }

    const revisionBefore = Number(billingCase.revision);
    assertExpectedRevision(revisionBefore, input.expectedRevision);
    assertApprovableStatus(String(billingCase.status));
    assertCurrency(String(billingCase.currency), input.currency);
    const versionNumber = Number(billingCase.current_version_number) + 1;
    await query(
      `INSERT INTO mbt_billing_versions (
         billing_version_id, billing_case_id, version_number, status,
         rate_card_version_id, calculation_snapshot,
         source_revision_snapshot, subtotal_minor, estimated_tax_minor,
         total_minor, currency, posting_mode, billing_case_revision_before,
         approved_by, approval_reason, approved_at, correlation_id,
         idempotency_key
       ) VALUES (
         $1, $2, $3, 'draft', $4, $5::jsonb,
         $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14,
         clock_timestamp(), $15, $16
       )`,
      [
        billingVersionId,
        input.billingCaseId,
        versionNumber,
        input.rateCardVersionId,
        JSON.stringify(input.calculationSnapshot),
        JSON.stringify(input.sourceRevisionSnapshot),
        input.subtotalMinor,
        input.estimatedTaxMinor,
        totalMinor,
        input.currency,
        postingMode,
        revisionBefore,
        input.approvedBy,
        input.approvalReason,
        input.correlationId,
        input.idempotencyKey
      ]
    );
    await query(
      "UPDATE mbt_billing_versions SET status = 'approved' WHERE billing_version_id = $1",
      [billingVersionId]
    );
    await query(
      `UPDATE mbt_billing_cases
          SET status = 'approved',
              current_version_number = $2,
              revision = $3,
              updated_by = $4,
              updated_at = clock_timestamp()
        WHERE billing_case_id = $1`,
      [
        input.billingCaseId,
        versionNumber,
        nextRevision(revisionBefore),
        input.approvedBy
      ]
    );
    const approval = await query(
      `SELECT ${APPROVAL_RESULT_COLUMNS}
         FROM mbt_billing_versions v
        WHERE v.billing_version_id = $1`,
      [billingVersionId]
    );
    if (!approval.rowCount) {
      throw new MbtError({
        status: 500,
        code: "MBT_BILLING_APPROVAL_INCOMPLETE",
        message: "The billing approval did not produce its immutable version."
      });
    }
    assertFinalApprovalRow(approval.rows[0]);
    assertApprovalIdentity(approval.rows[0], input, totalMinor, postingMode);
    return approvalResult(approval.rows[0], false);
  });
}
