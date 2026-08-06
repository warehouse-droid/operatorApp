// @ts-check

import crypto from "node:crypto";

import { MbtError } from "./errors.js";

/** @typedef {import("pg").Pool | import("pg").PoolClient} Database */
/** @typedef {import("pg").PoolClient} PoolClient */

/**
 * @typedef {object} DepositInput
 * @property {string} contractId
 * @property {string} fundsConfirmationReceiptId
 * @property {number} amountMinor
 * @property {string} currency
 * @property {string} paymentDate
 * @property {string} paymentMethod
 * @property {string} paymentReference
 * @property {string} accountMappingKey
 * @property {string} fundsConfirmedAt
 * @property {string} fundsConfirmedBy
 */

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
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

/** @param {unknown} value */
function positiveMinorAmount(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Deposit amount must be a positive integer number of minor currency units.");
  }
  return value;
}

/** @param {unknown} value */
function currencyCode(value) {
  const normalized = requiredText(value, "Deposit currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new TypeError("Deposit currency must be a three-letter ISO code.");
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function isoDate(value, label) {
  const normalized = requiredText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00.000Z`))) {
    throw new TypeError(`${label} must be an ISO date.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function isoTimestamp(value, label) {
  const normalized = requiredText(value, label);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`${label} must be an ISO timestamp.`);
  }
  return parsed.toISOString();
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value @returns {DepositInput} */
function normalizeDepositInput(value) {
  const input = /** @type {Partial<DepositInput>} */ (objectRecord(value));
  return {
    contractId: uuid(input.contractId, "Contract ID"),
    fundsConfirmationReceiptId: uuid(input.fundsConfirmationReceiptId, "Funds-confirmation receipt ID"),
    amountMinor: positiveMinorAmount(input.amountMinor),
    currency: currencyCode(input.currency),
    paymentDate: isoDate(input.paymentDate, "Payment date"),
    paymentMethod: requiredText(input.paymentMethod, "Payment method"),
    paymentReference: requiredText(input.paymentReference, "Payment reference"),
    accountMappingKey: requiredText(input.accountMappingKey, "Deposit account mapping key"),
    fundsConfirmedAt: isoTimestamp(input.fundsConfirmedAt, "Funds-confirmation time"),
    fundsConfirmedBy: requiredText(input.fundsConfirmedBy, "Funds confirmer")
  };
}

/** @returns {never} */
function rejectFundsConfirmation() {
  throw new MbtError({
    status: 409,
    code: "MBT_FUNDS_CONFIRMATION_REQUIRED",
    message: "An exact funds-confirmed command receipt is required."
  });
}

/** @param {Record<string, unknown>} receipt @param {DepositInput} input */
function assertFundsReceipt(receipt, input) {
  const response = objectRecord(receipt.response_body);
  const valid = receipt.command_name === "mbt.deposit.funds_confirmed"
    && Number(receipt.http_status) >= 200
    && Number(receipt.http_status) < 300
    && receipt.entity_type === "mbt_contract"
    && String(receipt.entity_id) === input.contractId
    && String(receipt.actor_operator_id) === input.fundsConfirmedBy
    && response.fundsConfirmed === true
    && String(response.contractId) === input.contractId
    && Number(response.amountMinor) === input.amountMinor
    && String(response.currency).toUpperCase() === input.currency
    && String(response.paymentReference) === input.paymentReference;
  if (!valid) {
    rejectFundsConfirmation();
  }
}

/** @param {Database} database @returns {Promise<{client: PoolClient, release: () => void}>} */
async function transactionClient(database) {
  if ("release" in database && typeof database.release === "function") {
    return { client: /** @type {PoolClient} */ (database), release: () => {} };
  }
  const pool = /** @type {import("pg").Pool} */ (database);
  const client = await pool.connect();
  return { client, release: () => client.release() };
}

/** @param {Record<string, unknown>} row @param {boolean} replayed */
function depositResult(row, replayed) {
  return {
    depositRecordId: String(row.deposit_record_id),
    status: String(row.status),
    replayed
  };
}

/**
 * Create a local deposit intent only from the exact immutable command receipt
 * that confirmed those same funds. This function does not enqueue or call a
 * NetSuite write adapter in Phase 1.
 *
 * @param {Database} database
 * @param {unknown} rawInput
 */
export async function createDepositRecord(database, rawInput) {
  const input = normalizeDepositInput(rawInput);
  const { client, release } = await transactionClient(database);
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.fundsConfirmationReceiptId]);
    const receipt = await client.query(
      `SELECT actor_operator_id, command_name, http_status, response_body,
              entity_type, entity_id
         FROM mbt_command_receipts
        WHERE receipt_id = $1
        FOR SHARE`,
      [input.fundsConfirmationReceiptId]
    );
    if (receipt.rowCount !== 1) {
      rejectFundsConfirmation();
    }
    assertFundsReceipt(receipt.rows[0], input);

    const existing = await client.query(
      `SELECT deposit_record_id, status
         FROM mbt_deposit_records
        WHERE funds_confirmation_receipt_id = $1`,
      [input.fundsConfirmationReceiptId]
    );
    if (existing.rowCount) {
      await client.query("COMMIT");
      return depositResult(existing.rows[0], true);
    }

    const contract = await client.query(
      `SELECT customer_netsuite_id
         FROM mbt_contracts
        WHERE contract_id = $1
        FOR SHARE`,
      [input.contractId]
    );
    if (contract.rowCount !== 1) {
      throw new MbtError({
        status: 404,
        code: "MBT_CONTRACT_NOT_FOUND",
        message: "The MBT contract was not found."
      });
    }
    const depositRecordId = crypto.randomUUID();
    const inserted = await client.query(
      `INSERT INTO mbt_deposit_records (
         deposit_record_id, customer_netsuite_id, contract_id,
         amount_minor, currency, payment_date, payment_method,
         payment_reference, account_mapping_key, funds_confirmed_at,
         funds_confirmed_by, funds_confirmation_receipt_id, status
       ) VALUES (
         $1, $2, $3, $4, $5, $6::date, $7, $8, $9,
         $10::timestamptz, $11, $12, 'pending'
       )
       RETURNING deposit_record_id, status`,
      [
        depositRecordId,
        contract.rows[0].customer_netsuite_id,
        input.contractId,
        input.amountMinor,
        input.currency,
        input.paymentDate,
        input.paymentMethod,
        input.paymentReference,
        input.accountMappingKey,
        input.fundsConfirmedAt,
        input.fundsConfirmedBy,
        input.fundsConfirmationReceiptId
      ]
    );
    await client.query("COMMIT");
    return depositResult(inserted.rows[0], false);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    release();
  }
}
