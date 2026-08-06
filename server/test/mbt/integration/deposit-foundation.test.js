import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import pg from "pg";

import { createDepositRecord } from "../../../src/mbt/deposit-repository.js";
import { createAssetFixture } from "../support/asset-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let fixture;
let customerId;

async function receipt(commandName, responseBody, overrides = {}) {
  const receiptId = crypto.randomUUID();
  const actorOperatorId = overrides.actorOperatorId ?? "p1-funds-clerk";
  const httpStatus = overrides.httpStatus ?? 200;
  const entityType = overrides.entityType ?? "mbt_contract";
  const entityId = overrides.entityId ?? fixture.contractId;
  await pool.query(
    `INSERT INTO mbt_command_receipts (
       receipt_id, actor_operator_id, actor_roles, command_name,
       idempotency_key, canonical_payload_hash, http_status, response_body,
       entity_type, entity_id, correlation_id, request_id
     ) VALUES (
       $1, $2, ARRAY['mbt_frontdesk']::text[], $3,
       $4, $5, $6, $7::jsonb, $8, $9, $10, $11
     )`,
    [
      receiptId,
      actorOperatorId,
      commandName,
      `idem-${receiptId}`,
      "a".repeat(64),
      httpStatus,
      JSON.stringify(responseBody),
      entityType,
      entityId,
      `corr-${receiptId}`,
      `req-${receiptId}`
    ]
  );
  return receiptId;
}

function depositInput(receiptId, overrides = {}) {
  return {
    contractId: fixture.contractId,
    fundsConfirmationReceiptId: receiptId,
    amountMinor: 25000,
    currency: "CAD",
    paymentDate: "2035-02-04",
    paymentMethod: "electronic_transfer",
    paymentReference: "P1-TRANSFER-100",
    accountMappingKey: "customer_deposit.cad",
    fundsConfirmedAt: "2035-02-04T15:00:00.000Z",
    fundsConfirmedBy: "p1-funds-clerk",
    ...overrides
  };
}

before(async () => {
  const client = await pool.connect();
  try {
    fixture = await createAssetFixture(client, { assetCount: 1, visitCount: 1 });
    const contract = await client.query(
      "SELECT customer_netsuite_id FROM mbt_contracts WHERE contract_id = $1",
      [fixture.contractId]
    );
    customerId = String(contract.rows[0].customer_netsuite_id);
  } finally {
    client.release();
  }
});

after(async () => {
  await pool.end();
});

test("F11: an arbitrary command receipt cannot authorize a Customer Deposit", async () => {
  const receiptId = await receipt("mbt.contract.note_updated", {
    fundsConfirmed: true,
    contractId: fixture.contractId,
    amountMinor: 25000,
    currency: "CAD",
    paymentReference: "P1-TRANSFER-100"
  });

  await assert.rejects(
    () => createDepositRecord(pool, depositInput(receiptId)),
    (error) => error?.status === 409
      && error?.code === "MBT_FUNDS_CONFIRMATION_REQUIRED"
  );
  const stored = await pool.query(
    "SELECT count(*)::int AS count FROM mbt_deposit_records WHERE funds_confirmation_receipt_id = $1",
    [receiptId]
  );
  assert.equal(stored.rows[0].count, 0);
});

test("F11: one exact funds-confirmed receipt creates at most one credential-free deposit intent", async () => {
  const receiptId = await receipt("mbt.deposit.funds_confirmed", {
    fundsConfirmed: true,
    contractId: fixture.contractId,
    amountMinor: 25000,
    currency: "CAD",
    paymentReference: "P1-TRANSFER-100"
  });
  const input = depositInput(receiptId);
  const outcomes = await Promise.all(Array.from({ length: 12 }, () => createDepositRecord(pool, input)));
  assert.equal(new Set(outcomes.map(({ depositRecordId }) => depositRecordId)).size, 1);
  assert.equal(outcomes.filter(({ replayed }) => replayed === false).length, 1);
  assert.equal(outcomes.filter(({ replayed }) => replayed === true).length, 11);

  const stored = await pool.query(
    `SELECT deposit_record_id, customer_netsuite_id::text AS customer_netsuite_id,
            contract_id, amount_minor::int AS amount_minor, currency,
            payment_method, payment_reference, account_mapping_key,
            funds_confirmed_at, funds_confirmed_by,
            funds_confirmation_receipt_id, status, netsuite_id
       FROM mbt_deposit_records
      WHERE funds_confirmation_receipt_id = $1`,
    [receiptId]
  );
  assert.equal(stored.rowCount, 1);
  assert.deepEqual(stored.rows[0], {
    deposit_record_id: outcomes[0].depositRecordId,
    customer_netsuite_id: customerId,
    contract_id: fixture.contractId,
    amount_minor: 25000,
    currency: "CAD",
    payment_method: "electronic_transfer",
    payment_reference: "P1-TRANSFER-100",
    account_mapping_key: "customer_deposit.cad",
    funds_confirmed_at: new Date("2035-02-04T15:00:00.000Z"),
    funds_confirmed_by: "p1-funds-clerk",
    funds_confirmation_receipt_id: receiptId,
    status: "pending",
    netsuite_id: null
  });

  const sensitiveColumns = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mbt_deposit_records'
        AND column_name ~ '(card|bank|routing|cvv|credential|account_number)'`
  );
  assert.deepEqual(sensitiveColumns.rows, []);
});

test("F11: malformed deposit commands fail before durable work", async () => {
  const validReceiptId = crypto.randomUUID();
  const valid = depositInput(validReceiptId);
  const cases = [
    [null, /contract id is required/i],
    [[], /contract id is required/i],
    [{ ...valid, contractId: "not-a-uuid" }, /contract id must be a uuid/i],
    [{ ...valid, fundsConfirmationReceiptId: "not-a-uuid" }, /receipt id must be a uuid/i],
    [{ ...valid, amountMinor: "25000" }, /positive integer/i],
    [{ ...valid, amountMinor: Number.MAX_SAFE_INTEGER + 1 }, /positive integer/i],
    [{ ...valid, amountMinor: 0 }, /positive integer/i],
    [{ ...valid, currency: "CA" }, /three-letter iso code/i],
    [{ ...valid, paymentDate: "04-02-2035" }, /iso date/i],
    [{ ...valid, paymentDate: "2035-99-99" }, /iso date/i],
    [{ ...valid, paymentMethod: " " }, /payment method is required/i],
    [{ ...valid, paymentReference: "" }, /payment reference is required/i],
    [{ ...valid, accountMappingKey: "" }, /mapping key is required/i],
    [{ ...valid, fundsConfirmedAt: "not-a-time" }, /iso timestamp/i],
    [{ ...valid, fundsConfirmedBy: "" }, /funds confirmer is required/i]
  ];

  for (const [candidate, pattern] of cases) {
    await assert.rejects(() => createDepositRecord(pool, candidate), pattern);
  }
  const retained = await pool.query(
    "SELECT count(*)::int AS count FROM mbt_deposit_records WHERE funds_confirmation_receipt_id = $1",
    [validReceiptId]
  );
  assert.equal(retained.rows[0].count, 0);
});

test("F11: every mismatched funds-confirmation identity is rejected exactly", async () => {
  const baseResponse = {
    fundsConfirmed: true,
    contractId: fixture.contractId,
    amountMinor: 25000,
    currency: "CAD",
    paymentReference: "P1-TRANSFER-100"
  };
  const cases = [
    { commandName: "mbt.contract.note_updated" },
    { httpStatus: 199 },
    { httpStatus: 300 },
    { entityType: "mbt_quote" },
    { entityId: crypto.randomUUID() },
    { actorOperatorId: "another-clerk" },
    { response: { ...baseResponse, fundsConfirmed: false } },
    { response: { ...baseResponse, contractId: crypto.randomUUID() } },
    { response: { ...baseResponse, amountMinor: 24999 } },
    { response: { ...baseResponse, currency: "USD" } },
    { response: { ...baseResponse, paymentReference: "OTHER-TRANSFER" } }
  ];

  for (const candidate of cases) {
    const receiptId = await receipt(
      candidate.commandName ?? "mbt.deposit.funds_confirmed",
      candidate.response ?? baseResponse,
      candidate
    );
    await assert.rejects(
      () => createDepositRecord(pool, depositInput(receiptId)),
      (error) => error?.status === 409 && error?.code === "MBT_FUNDS_CONFIRMATION_REQUIRED"
    );
  }

  const missingReceiptId = crypto.randomUUID();
  await assert.rejects(
    () => createDepositRecord(pool, depositInput(missingReceiptId)),
    (error) => error?.status === 409 && error?.code === "MBT_FUNDS_CONFIRMATION_REQUIRED"
  );
});

test("F11: a matching receipt for a missing contract rolls back cleanly", async () => {
  const missingContractId = crypto.randomUUID();
  const paymentReference = `P1-MISSING-${missingContractId}`;
  const receiptId = await receipt(
    "mbt.deposit.funds_confirmed",
    {
      fundsConfirmed: true,
      contractId: missingContractId,
      amountMinor: 25000,
      currency: "CAD",
      paymentReference
    },
    { entityId: missingContractId }
  );

  await assert.rejects(
    () => createDepositRecord(pool, depositInput(receiptId, {
      contractId: missingContractId,
      paymentReference
    })),
    (error) => error?.status === 404 && error?.code === "MBT_CONTRACT_NOT_FOUND"
  );
  const retained = await pool.query(
    "SELECT count(*)::int AS count FROM mbt_deposit_records WHERE funds_confirmation_receipt_id = $1",
    [receiptId]
  );
  assert.equal(retained.rows[0].count, 0);
});

test("F11: callers may supply an already-acquired PostgreSQL client without transferring its ownership", async () => {
  const paymentReference = `P1-CLIENT-${crypto.randomUUID()}`;
  const receiptId = await receipt("mbt.deposit.funds_confirmed", {
    fundsConfirmed: true,
    contractId: fixture.contractId,
    amountMinor: 25000,
    currency: "CAD",
    paymentReference
  });
  const client = await pool.connect();
  try {
    const result = await createDepositRecord(client, depositInput(receiptId, { paymentReference }));
    assert.equal(result.replayed, false);
    const stillUsable = await client.query("SELECT 1::int AS value");
    assert.deepEqual(stillUsable.rows, [{ value: 1 }]);
  } finally {
    client.release();
  }
});
