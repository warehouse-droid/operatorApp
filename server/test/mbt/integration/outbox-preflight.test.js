import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { canonicalSha256 } from "../../../src/mbt/canonical-json.js";
import {
  claimNextNetSuiteOutbox,
  enqueueNetSuiteOutbox,
  markNetSuiteOutboxSendStarted,
  markNetSuiteOutboxSent,
  recordNetSuiteOutboxFailure,
  recoverExpiredNetSuiteOutboxLeases
} from "../../../src/mbt/outbox-repository.js";
import {
  getCurrentNetSuiteConfiguration,
  getNetSuitePreflightReadiness,
  runNetSuitePreflight
} from "../../../src/mbt/preflight-repository.js";
import { configurationHash } from "../../../src/mbt/preflight.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const HASH = "a".repeat(64);
const SEEDED_BIN_TYPE_ID = "00000000-0000-4000-8000-000000000014";
let fixtureSequence = 0;

function identity(label) {
  fixtureSequence += 1;
  const suffix = `${RUN_ID}${fixtureSequence}`;
  return {
    label: `${label}-${suffix}`,
    key: `mbt-p1-${label}-${suffix}`,
    localKey: `p1.${label}.${suffix}`
  };
}

async function createBillingFixture(label, { postingMode = "local_only" } = {}) {
  const value = identity(label);
  const fixture = {
    ...value,
    customerId: 1_000_000_000 + crypto.randomInt(0, 1_000_000_000),
    addressId: crypto.randomUUID(),
    siteProfileId: crypto.randomUUID(),
    templateId: crypto.randomUUID(),
    templateVersionId: crypto.randomUUID(),
    rateCardId: crypto.randomUUID(),
    rateCardVersionId: crypto.randomUUID(),
    contractId: crypto.randomUUID(),
    billingCaseId: crypto.randomUUID(),
    billingVersionId: crypto.randomUUID()
  };
  await query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, currency,
       source_modified_at, source_version, payload_hash
     ) VALUES ($1, $2, $3, $3, 'CAD', now(), 'p1', $4)`,
    [fixture.customerId, `C-${fixture.label}`, `Customer ${fixture.label}`, HASH]
  );
  await query(
    `INSERT INTO netsuite_customer_addresses (
       address_id, customer_netsuite_id, netsuite_address_id,
       source_modified_at, source_version, payload_hash
     ) VALUES ($1, $2, $3, now(), 'p1', $4)`,
    [fixture.addressId, fixture.customerId, `ADDR-${fixture.label}`, HASH]
  );
  await query(
    `INSERT INTO mbt_customer_site_profiles (
       site_profile_id, customer_netsuite_id, address_id, created_by, updated_by
     ) VALUES ($1, $2, $3, 'p1-test', 'p1-test')`,
    [fixture.siteProfileId, fixture.customerId, fixture.addressId]
  );
  await query(
    `INSERT INTO mbt_service_templates (
       template_id, template_code, display_name, created_by, updated_by
     ) VALUES ($1, $2, $3, 'p1-test', 'p1-test')`,
    [fixture.templateId, `TPL-${fixture.label}`, `Template ${fixture.label}`]
  );
  await query(
    `INSERT INTO mbt_service_template_versions (
       template_version_id, template_id, version_number, status, created_by, updated_by
     ) VALUES ($1, $2, 1, 'draft', 'p1-test', 'p1-test')`,
    [fixture.templateVersionId, fixture.templateId]
  );
  await query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, customer_netsuite_id,
       subsidiary_netsuite_id, currency, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, 33, 'CAD', 'p1-test', 'p1-test')`,
    [fixture.rateCardId, `RATE-${fixture.label}`, `Rate ${fixture.label}`, fixture.customerId]
  );
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       validation_snapshot, created_by, updated_by
     ) VALUES ($1, $2, 1, 'draft', '{}'::jsonb, 'p1-test', 'p1-test')`,
    [fixture.rateCardVersionId, fixture.rateCardId]
  );
  await query(
    `INSERT INTO mbt_contracts (
       contract_id, contract_number, customer_netsuite_id,
       customer_site_profile_id, service_template_version_id,
       rate_card_version_id, bin_type_id, status,
       customer_snapshot, site_snapshot, terms_snapshot, tax_snapshot,
       pricing_snapshot, currency, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'draft',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, 'CAD', 'p1-test', 'p1-test'
     )`,
    [
      fixture.contractId,
      `CON-${fixture.label}`,
      fixture.customerId,
      fixture.siteProfileId,
      fixture.templateVersionId,
      fixture.rateCardVersionId,
      SEEDED_BIN_TYPE_ID
    ]
  );
  await query(
    `INSERT INTO mbt_billing_cases (
       billing_case_id, case_type, contract_id, customer_netsuite_id,
       status, currency, posting_mode, revision, created_by, updated_by
     ) VALUES ($1, 'mbt_contract', $2, $3, 'ready', 'CAD', $4, 1, 'p1-test', 'p1-test')`,
    [fixture.billingCaseId, fixture.contractId, fixture.customerId, postingMode]
  );
  return { ...fixture, postingMode };
}

function approveBillingMutation(fixture) {
  return async () => {
    await query(
      `INSERT INTO mbt_billing_versions (
         billing_version_id, billing_case_id, version_number, status,
       rate_card_version_id, calculation_snapshot, source_revision_snapshot,
       subtotal_minor, estimated_tax_minor, total_minor, currency,
       posting_mode, billing_case_revision_before, approved_by,
       approval_reason, approved_at, correlation_id, idempotency_key
     ) VALUES (
       $1, $2, 1, 'approved', $3, '{}'::jsonb, '{"billingRevision":1}'::jsonb,
       10000, 1300, 11300, 'CAD', $4, 1, 'p1-billing', 'Phase 1 atomicity',
       now(), $5, $6
       )`,
      [
        fixture.billingVersionId,
        fixture.billingCaseId,
        fixture.rateCardVersionId,
        fixture.postingMode,
        `corr-${fixture.label}`,
        fixture.key
      ]
    );
    await query(
      `UPDATE mbt_billing_cases
          SET status = 'approved',
              current_version_number = 1,
              revision = 2,
              updated_by = 'p1-billing',
              updated_at = now()
        WHERE billing_case_id = $1`,
      [fixture.billingCaseId]
    );
  };
}

async function createOutbox(label, payload = { test: true }) {
  const value = identity(label);
  const result = await enqueueNetSuiteOutbox({
    externalIdempotencyKey: value.key,
    operationType: "create_sales_order",
    targetRecordType: "sales_order",
    payload
  });
  return { ...value, ...result.outbox };
}

async function insertMapping({
  label,
  mappingType,
  externalRecordType,
  externalId,
  externalScriptId = null,
  subsidiaryNetSuiteId = 33,
  active = true,
  isCurrent = true,
  validationStatus = "valid",
  revision = 1,
  localKey
}) {
  const value = identity(label);
  const mapping = {
    mappingId: crypto.randomUUID(),
    mappingType,
    localKey: localKey || value.localKey,
    externalId,
    externalScriptId,
    externalRecordType,
    subsidiaryNetSuiteId,
    active,
    isCurrent,
    validationStatus,
    revision
  };
  const verified = validationStatus === "valid";
  await query(
    `INSERT INTO mbt_netsuite_mappings (
       mapping_id, mapping_type, local_key, external_id, external_script_id, external_name,
       external_record_type, subsidiary_netsuite_id, configuration,
       active, is_current, validation_status, validation_message,
       last_verified_at, last_verified_by, revision, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb,
       $9, $10, $11, '', $12, $13, $14, 'p1-test'
     )`,
    [
      mapping.mappingId,
      mapping.mappingType,
      mapping.localKey,
      mapping.externalId,
      mapping.externalScriptId,
      `${label} mapping`,
      mapping.externalRecordType,
      mapping.subsidiaryNetSuiteId,
      mapping.active,
      mapping.isCurrent,
      mapping.validationStatus,
      verified ? new Date().toISOString() : null,
      verified ? "p1-test" : null,
      mapping.revision
    ]
  );
  return mapping;
}

function trackedAdapter(readImplementation) {
  const counts = { reads: 0, writes: 0 };
  const rejectWrite = async () => {
    counts.writes += 1;
    throw new MbtError({
      status: 409,
      code: "MBT_NETSUITE_WRITE_DISABLED",
      message: "NetSuite operational writes are disabled in MBT Phase 1."
    });
  };
  return {
    counts,
    adapter: Object.freeze({
      async readRecord(recordType, externalId) {
        counts.reads += 1;
        return readImplementation(recordType, externalId);
      },
      createSalesOrder: rejectWrite,
      createDeposit: rejectWrite,
      updateSalesOrder: rejectWrite,
      deleteRecord: rejectWrite
    })
  };
}

function requirement(mapping, checkType, expectedSubsidiaryId = 33) {
  return {
    checkType,
    mappingType: mapping.mappingType,
    localKey: mapping.localKey,
    required: true,
    expectedSubsidiaryId
  };
}

function preflightInput(adapter, requiredMappings, overrides = {}) {
  return {
    adapter,
    adapterKind: "phase1_read_only_fake",
    accountId: "P1_TEST_ACCOUNT",
    expectedAccountId: "P1_TEST_ACCOUNT",
    environmentName: "test",
    requestedBy: "p1-admin",
    correlationId: `corr-preflight-${crypto.randomUUID()}`,
    requiredMappings,
    ...overrides
  };
}

async function repositoryFunction(modulePath, exportName) {
  let repository;
  try {
    repository = await import(modulePath);
  } catch (error) {
    assert.fail(`${exportName} repository module is required: ${String(error?.message || error)}`);
  }
  assert.equal(typeof repository[exportName], "function", `${exportName} must be implemented.`);
  return repository[exportName];
}

async function createUncertainOutbox(label, externalId) {
  const event = await createOutbox(label, { externalId, memo: `uncertain ${label}` });
  const workerId = `p1-send-${label}-${RUN_ID}`;
  const claimed = await claimNextNetSuiteOutbox({ workerId, leaseSeconds: 30 });
  assert.equal(claimed.outboxId, event.outboxId);
  await markNetSuiteOutboxSendStarted({
    outboxId: claimed.outboxId,
    leaseToken: claimed.leaseToken,
    workerId,
    sentAt: new Date()
  });
  const failed = await recordNetSuiteOutboxFailure({
    outboxId: claimed.outboxId,
    leaseToken: claimed.leaseToken,
    workerId,
    errorCode: "CONNECTION_LOST_AFTER_SEND",
    errorMessage: "The create request may have reached NetSuite."
  });
  assert.equal(failed.state, "attention");
  assert.equal(failed.lookupRequired, true);
  return { event, failed };
}

function approvalInput(fixture, overrides = {}) {
  return {
    billingCaseId: fixture.billingCaseId,
    expectedRevision: 1,
    rateCardVersionId: fixture.rateCardVersionId,
    calculationSnapshot: { source: "p1-billing-test", lineCount: 1 },
    sourceRevisionSnapshot: { billingRevision: 1 },
    subtotalMinor: 10_000,
    estimatedTaxMinor: 1_300,
    currency: "CAD",
    approvedBy: "p1-billing-approver",
    approvalReason: "Verified Phase 1 billing approval",
    correlationId: `corr-approval-${fixture.label}`,
    idempotencyKey: fixture.key,
    ...overrides
  };
}

async function insertNonFinalApprovalVersion(fixture, input, status) {
  await query(
    `INSERT INTO mbt_billing_versions (
       billing_version_id, billing_case_id, version_number, status,
       rate_card_version_id, calculation_snapshot, source_revision_snapshot,
       subtotal_minor, estimated_tax_minor, total_minor, currency,
       posting_mode, billing_case_revision_before, approved_by,
       approval_reason, approved_at, correlation_id, idempotency_key
     ) VALUES (
       $1, $2, 1, $3, $4, $5::jsonb, $6::jsonb,
       $7, $8, $9, $10, $11, $12, $13,
       $14, clock_timestamp(), $15, $16
     )`,
    [
      crypto.randomUUID(),
      fixture.billingCaseId,
      status,
      input.rateCardVersionId,
      JSON.stringify(input.calculationSnapshot),
      JSON.stringify(input.sourceRevisionSnapshot),
      input.subtotalMinor,
      input.estimatedTaxMinor,
      input.subtotalMinor + input.estimatedTaxMinor,
      input.currency,
      fixture.postingMode,
      input.expectedRevision,
      input.approvedBy,
      input.approvalReason,
      input.correlationId,
      input.idempotencyKey
    ]
  );
}

before(async () => {
  // Repeated gauntlet runs share one disposable database. Retire only stale
  // eligible rows created by an earlier interrupted copy of this test packet.
  await query(
    `UPDATE mbt_netsuite_outbox
        SET state = 'voided',
            lease_token = NULL,
            lease_owner = NULL,
            lease_acquired_at = NULL,
            lease_expires_at = NULL
      WHERE state IN ('pending', 'leased')
        AND (
          external_idempotency_key LIKE 'mbt-p1-%'
          OR external_idempotency_key LIKE 'mbt-billing-%'
          OR external_idempotency_key LIKE 'p1-claim-%'
        )`
  );
});

after(async () => {
  await closeDb();
});

test("F12 legacy foundation: explicit future intent can still exercise outbox atomicity", async () => {
  const fixture = await createBillingFixture("billing_atomic", { postingMode: "netsuite_future" });
  const payload = {
    externalId: fixture.key,
    customer: fixture.customerId,
    totalMinor: 11300,
    currency: "CAD"
  };
  const first = await enqueueNetSuiteOutbox({
    externalIdempotencyKey: fixture.key,
    operationType: "create_sales_order",
    targetRecordType: "sales_order",
    payload,
    billingVersionId: fixture.billingVersionId,
    businessMutation: approveBillingMutation(fixture)
  });
  let replayMutationCalled = false;
  const replay = await enqueueNetSuiteOutbox({
    externalIdempotencyKey: fixture.key,
    operationType: "create_sales_order",
    targetRecordType: "sales_order",
    payload: { currency: "CAD", totalMinor: 11300, customer: fixture.customerId, externalId: fixture.key },
    billingVersionId: fixture.billingVersionId,
    businessMutation: async () => {
      replayMutationCalled = true;
      throw new Error("An outbox replay must not repeat billing approval.");
    }
  });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.outbox.outboxId, replay.outbox.outboxId);
  assert.equal(first.outbox.externalIdempotencyKey, fixture.key);
  assert.equal(first.outbox.payloadHash, canonicalSha256(payload));
  assert.equal(replayMutationCalled, false);

  const state = await query(
    `SELECT b.status, b.revision::int AS revision, b.current_version_number,
            count(v.*)::int AS versions,
            count(o.*)::int AS outbox_rows
       FROM mbt_billing_cases b
       LEFT JOIN mbt_billing_versions v ON v.billing_case_id = b.billing_case_id
       LEFT JOIN mbt_netsuite_outbox o ON o.billing_version_id = v.billing_version_id
      WHERE b.billing_case_id = $1
      GROUP BY b.billing_case_id`,
    [fixture.billingCaseId]
  );
  assert.deepEqual(state.rows[0], {
    status: "approved",
    revision: 2,
    current_version_number: 1,
    versions: 1,
    outbox_rows: 1
  });

  await assert.rejects(
    () => enqueueNetSuiteOutbox({
      externalIdempotencyKey: fixture.key,
      operationType: "create_sales_order",
      targetRecordType: "sales_order",
      payload: { ...payload, totalMinor: 9999 },
      billingVersionId: fixture.billingVersionId
    }),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_OUTBOX_IDENTITY_CONFLICT"
  );

  // This test proves enqueue atomicity but does not run a worker. Keep its
  // durable row from becoming eligible work for the later worker tests.
  await query(
    "UPDATE mbt_netsuite_outbox SET state = 'voided' WHERE outbox_id = $1",
    [first.outbox.outboxId]
  );
});

test("F12 legacy foundation: an injected outbox failure still rolls future-intent evidence back", async () => {
  const fixture = await createBillingFixture("billing_rollback", { postingMode: "netsuite_future" });
  await assert.rejects(
    () => enqueueNetSuiteOutbox({
      externalIdempotencyKey: fixture.key,
      operationType: "invalid_operation_for_atomicity_test",
      targetRecordType: "sales_order",
      payload: { externalId: fixture.key },
      billingVersionId: fixture.billingVersionId,
      businessMutation: approveBillingMutation(fixture)
    }),
    (error) => error?.code === "23514"
  );

  const state = await query(
    `SELECT b.status, b.revision::int AS revision, b.current_version_number,
            (SELECT count(*)::int FROM mbt_billing_versions WHERE billing_case_id = b.billing_case_id) AS versions,
            (SELECT count(*)::int FROM mbt_netsuite_outbox WHERE external_idempotency_key = $2) AS outbox_rows
       FROM mbt_billing_cases b
      WHERE b.billing_case_id = $1`,
    [fixture.billingCaseId, fixture.key]
  );
  assert.deepEqual(state.rows[0], {
    status: "ready",
    revision: 1,
    current_version_number: 0,
    versions: 0,
    outbox_rows: 0
  });
});

test("F12: malformed commands fail before persistence and a future event cannot be claimed early", async () => {
  const invalidPayload = identity("invalid_payload");
  const invalidMutation = identity("invalid_mutation");
  const invalidTimestamp = identity("invalid_timestamp");

  await assert.rejects(
    () => enqueueNetSuiteOutbox({
      externalIdempotencyKey: null,
      operationType: "create_sales_order",
      targetRecordType: "sales_order",
      payload: { externalId: "missing-key" }
    }),
    { name: "TypeError", message: "An outbox external idempotency key is required." }
  );
  await assert.rejects(
    () => enqueueNetSuiteOutbox({
      externalIdempotencyKey: invalidPayload.key,
      operationType: "create_sales_order",
      targetRecordType: "sales_order",
      payload: []
    }),
    { name: "TypeError", message: "An outbox payload object is required." }
  );
  await assert.rejects(
    () => enqueueNetSuiteOutbox({
      externalIdempotencyKey: invalidMutation.key,
      operationType: "create_sales_order",
      targetRecordType: "sales_order",
      payload: { externalId: invalidMutation.key },
      businessMutation: {}
    }),
    { name: "TypeError", message: "An outbox business mutation must be a function." }
  );
  await assert.rejects(
    () => enqueueNetSuiteOutbox({
      externalIdempotencyKey: invalidTimestamp.key,
      operationType: "create_sales_order",
      targetRecordType: "sales_order",
      payload: { externalId: invalidTimestamp.key },
      nextAttemptAt: null
    }),
    { name: "TypeError", message: "A valid next attempt timestamp is required." }
  );
  await assert.rejects(
    () => claimNextNetSuiteOutbox({ workerId: "p1-invalid-lease", leaseSeconds: 0 }),
    { name: "TypeError", message: "A positive integer lease duration is required." }
  );

  const absent = await query(
    `SELECT count(*)::int AS count
       FROM mbt_netsuite_outbox
      WHERE external_idempotency_key = ANY($1::text[])`,
    [[invalidPayload.key, invalidMutation.key, invalidTimestamp.key]]
  );
  assert.equal(absent.rows[0].count, 0);

  const scheduledIdentity = identity("scheduled_claim");
  const scheduledAt = new Date(Date.now() + 3_600_000);
  const scheduled = await enqueueNetSuiteOutbox({
    externalIdempotencyKey: scheduledIdentity.key,
    operationType: "create_sales_order",
    targetRecordType: "sales_order",
    payload: { externalId: scheduledIdentity.key },
    nextAttemptAt: scheduledAt
  });
  assert.equal(new Date(scheduled.outbox.nextAttemptAt).toISOString(), scheduledAt.toISOString());
  assert.equal(
    await claimNextNetSuiteOutbox({ workerId: "p1-too-early", leaseSeconds: 30 }),
    null
  );

  await query(
    "UPDATE mbt_netsuite_outbox SET next_attempt_at = now() - interval '1 second' WHERE outbox_id = $1",
    [scheduled.outbox.outboxId]
  );
  const claimed = await claimNextNetSuiteOutbox({ workerId: "p1-scheduled-owner", leaseSeconds: 30 });
  assert.equal(claimed.outboxId, scheduled.outbox.outboxId);
  await assert.rejects(
    () => markNetSuiteOutboxSendStarted({
      outboxId: claimed.outboxId,
      leaseToken: claimed.leaseToken,
      workerId: "p1-lease-hijacker",
      sentAt: new Date()
    }),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_OUTBOX_LEASE_LOST"
  );
  const stillOwned = await query(
    `SELECT state, lease_owner, attempt_count::int AS attempt_count
       FROM mbt_netsuite_outbox
      WHERE outbox_id = $1`,
    [claimed.outboxId]
  );
  assert.deepEqual(stillOwned.rows[0], {
    state: "leased",
    lease_owner: "p1-scheduled-owner",
    attempt_count: 1
  });
  await query(
    `UPDATE mbt_netsuite_outbox
        SET state = 'voided', lease_token = NULL, lease_owner = NULL,
            lease_acquired_at = NULL, lease_expires_at = NULL
      WHERE outbox_id = $1`,
    [claimed.outboxId]
  );
});

test("F12: an explicit send timestamp makes a failed attempt uncertain without changing its identity", async () => {
  const event = await createOutbox("explicit_send_failure", { externalId: "explicit-send-failure" });
  const claimed = await claimNextNetSuiteOutbox({ workerId: "p1-worker-explicit-send", leaseSeconds: 30 });
  assert.equal(claimed.outboxId, event.outboxId);
  const sentAt = new Date();
  const failed = await recordNetSuiteOutboxFailure({
    outboxId: claimed.outboxId,
    leaseToken: claimed.leaseToken,
    workerId: "p1-worker-explicit-send",
    errorCode: "NO_ACKNOWLEDGEMENT",
    errorMessage: "The connection ended before an acknowledgement arrived.",
    sentAt
  });
  assert.equal(failed.state, "attention");
  assert.equal(failed.lookupRequired, true);
  assert.equal(failed.externalIdempotencyKey, event.externalIdempotencyKey);
  assert.equal(failed.payloadHash, event.payloadHash);
  assert.equal(new Date(failed.sentAt).toISOString(), sentAt.toISOString());

  const attempt = await query(
    `SELECT outcome, sent_at
       FROM mbt_netsuite_outbox_attempts
      WHERE outbox_id = $1`,
    [claimed.outboxId]
  );
  assert.deepEqual(attempt.rows.map(({ outcome, sent_at: attemptSentAt }) => ({
    outcome,
    sentAt: new Date(attemptSentAt).toISOString()
  })), [{ outcome: "uncertain", sentAt: sentAt.toISOString() }]);
});

test("F12: sent state requires acknowledgement and stores one append-only successful attempt", async () => {
  const event = await createOutbox("ack_required", { externalId: "ack-required" });
  const claimed = await claimNextNetSuiteOutbox({ workerId: "p1-worker-ack", leaseSeconds: 30 });
  assert.equal(claimed.outboxId, event.outboxId);
  const sentAt = new Date().toISOString();

  await assert.rejects(
    () => markNetSuiteOutboxSent({
      outboxId: claimed.outboxId,
      leaseToken: claimed.leaseToken,
      workerId: "p1-worker-ack",
      sentAt,
      externalAcknowledgedAt: null,
      netsuiteId: 81001,
      netsuiteReference: "SO81001",
      responseSnapshot: { id: 81001 }
    }),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_OUTBOX_ACK_REQUIRED"
  );
  const stillLeased = await query(
    `SELECT state, attempt_count::int AS attempt_count,
            (SELECT count(*)::int FROM mbt_netsuite_outbox_attempts WHERE outbox_id = $1) AS attempts
       FROM mbt_netsuite_outbox
      WHERE outbox_id = $1`,
    [claimed.outboxId]
  );
  assert.deepEqual(stillLeased.rows[0], { state: "leased", attempt_count: 1, attempts: 0 });

  const acknowledgedAt = new Date().toISOString();
  const sent = await markNetSuiteOutboxSent({
    outboxId: claimed.outboxId,
    leaseToken: claimed.leaseToken,
    workerId: "p1-worker-ack",
    sentAt,
    externalAcknowledgedAt: acknowledgedAt,
    netsuiteId: 81001,
    netsuiteReference: "SO81001",
    responseSnapshot: { id: 81001, tranId: "SO81001" }
  });
  assert.equal(sent.state, "sent");
  assert.equal(sent.externalIdempotencyKey, event.externalIdempotencyKey);
  assert.equal(sent.netsuiteId, 81001);
  const attempt = await query(
    `SELECT attempt_number::int AS attempt_number, worker_id, attempt_stage,
            outcome, request_payload_hash, netsuite_id, netsuite_reference
       FROM mbt_netsuite_outbox_attempts
      WHERE outbox_id = $1`,
    [claimed.outboxId]
  );
  assert.deepEqual(attempt.rows[0], {
    attempt_number: 1,
    worker_id: "p1-worker-ack",
    attempt_stage: "send",
    outcome: "succeeded",
    request_payload_hash: event.payloadHash,
    netsuite_id: "81001",
    netsuite_reference: "SO81001"
  });
});

test("F12: a failure after send-started remains uncertain even when the caller omits sentAt", async () => {
  const event = await createOutbox("send_started_failure", { externalId: "uncertain-after-start" });
  const claimed = await claimNextNetSuiteOutbox({ workerId: "p1-worker-started-failure", leaseSeconds: 30 });
  assert.equal(claimed.outboxId, event.outboxId);
  const sentAt = new Date().toISOString();
  await markNetSuiteOutboxSendStarted({
    outboxId: claimed.outboxId,
    leaseToken: claimed.leaseToken,
    workerId: "p1-worker-started-failure",
    sentAt
  });
  const failed = await recordNetSuiteOutboxFailure({
    outboxId: claimed.outboxId,
    leaseToken: claimed.leaseToken,
    workerId: "p1-worker-started-failure",
    errorCode: "CONNECTION_DROPPED",
    errorMessage: "Connection dropped after request transmission"
  });
  assert.equal(failed.state, "attention");
  assert.equal(failed.lookupRequired, true);
  assert.equal(failed.attentionReason, "external_outcome_uncertain");
  assert.equal(new Date(failed.sentAt).toISOString(), sentAt);
  assert.equal(failed.externalIdempotencyKey, event.externalIdempotencyKey);
});

test("F12: retry and expired-lease recovery preserve identity and never blindly replay an uncertain send", async () => {
  const retryEvent = await createOutbox("retry_identity", { externalId: "stable-retry" });
  const firstClaim = await claimNextNetSuiteOutbox({ workerId: "p1-worker-retry-1", leaseSeconds: 30 });
  assert.equal(firstClaim.outboxId, retryEvent.outboxId);
  const failed = await recordNetSuiteOutboxFailure({
    outboxId: firstClaim.outboxId,
    leaseToken: firstClaim.leaseToken,
    workerId: "p1-worker-retry-1",
    errorCode: "NETSUITE_503",
    errorMessage: "Temporary unavailable",
    retryAt: new Date(Date.now() - 1_000).toISOString()
  });
  assert.equal(failed.state, "pending");
  assert.equal(failed.externalIdempotencyKey, retryEvent.externalIdempotencyKey);
  assert.equal(failed.payloadHash, retryEvent.payloadHash);

  const secondClaim = await claimNextNetSuiteOutbox({ workerId: "p1-worker-retry-2", leaseSeconds: 30 });
  assert.equal(secondClaim.outboxId, retryEvent.outboxId);
  assert.equal(secondClaim.externalIdempotencyKey, retryEvent.externalIdempotencyKey);
  assert.equal(secondClaim.payloadHash, retryEvent.payloadHash);
  assert.equal(secondClaim.attemptCount, 2);
  const sendStartedAt = new Date(Date.now() - 120_000).toISOString();
  await markNetSuiteOutboxSendStarted({
    outboxId: secondClaim.outboxId,
    leaseToken: secondClaim.leaseToken,
    workerId: "p1-worker-retry-2",
    sentAt: sendStartedAt
  });
  await query(
    `UPDATE mbt_netsuite_outbox
        SET lease_acquired_at = now() - interval '2 minutes',
            lease_expires_at = now() - interval '1 minute'
      WHERE outbox_id = $1`,
    [secondClaim.outboxId]
  );
  const uncertainRecovery = await recoverExpiredNetSuiteOutboxLeases({ limit: 10 });
  const uncertain = uncertainRecovery.find(({ outboxId }) => outboxId === secondClaim.outboxId);
  assert.equal(uncertain.state, "attention");
  assert.equal(uncertain.lookupRequired, true);
  assert.equal(uncertain.attentionReason, "external_outcome_uncertain");
  assert.equal(uncertain.externalIdempotencyKey, retryEvent.externalIdempotencyKey);

  const preSendEvent = await createOutbox("presend_recovery", { externalId: "pre-send" });
  const preSendClaim = await claimNextNetSuiteOutbox({ workerId: "p1-worker-presend", leaseSeconds: 30 });
  assert.equal(preSendClaim.outboxId, preSendEvent.outboxId);
  await query(
    `UPDATE mbt_netsuite_outbox
        SET lease_acquired_at = now() - interval '2 minutes',
            lease_expires_at = now() - interval '1 minute'
      WHERE outbox_id = $1`,
    [preSendClaim.outboxId]
  );
  const preSendRecovery = await recoverExpiredNetSuiteOutboxLeases({ limit: 10 });
  const recovered = preSendRecovery.find(({ outboxId }) => outboxId === preSendClaim.outboxId);
  assert.equal(recovered.state, "pending");
  assert.equal(recovered.lookupRequired, false);
  assert.equal(recovered.externalIdempotencyKey, preSendEvent.externalIdempotencyKey);

  const attempt = await query(
    `SELECT outbox_attempt_id
       FROM mbt_netsuite_outbox_attempts
      WHERE outbox_id = $1
      ORDER BY attempt_number
      LIMIT 1`,
    [retryEvent.outboxId]
  );
  assert.equal(attempt.rowCount, 1);
  for (const sql of [
    "UPDATE mbt_netsuite_outbox_attempts SET error_message = 'rewritten' WHERE outbox_attempt_id = $1",
    "DELETE FROM mbt_netsuite_outbox_attempts WHERE outbox_attempt_id = $1"
  ]) {
    await assert.rejects(
      () => query(sql, [attempt.rows[0].outbox_attempt_id]),
      (error) => error?.code === "55000"
    );
  }
  const blindReplay = await claimNextNetSuiteOutbox({ workerId: "must-not-claim-attention", leaseSeconds: 30 });
  assert.notEqual(blindReplay?.outboxId, retryEvent.outboxId);
});

test("F12: uncertain create lookup found reconciles without another create and appends durable evidence", async () => {
  const resolveUncertainNetSuiteCreate = await repositoryFunction(
    "../../../src/mbt/outbox-repository.js",
    "resolveUncertainNetSuiteCreate"
  );
  const externalId = `mbt-found-${RUN_ID}`;
  const { event } = await createUncertainOutbox("lookup_found", externalId);
  let lookupCalls = 0;
  const resolution = await resolveUncertainNetSuiteCreate({
    outboxId: event.outboxId,
    workerId: `p1-lookup-found-${RUN_ID}`,
    lookupByExternalId: async ({ recordType, externalId: requestedExternalId, payloadHash }) => {
      lookupCalls += 1;
      assert.equal(recordType, "sales_order");
      assert.equal(requestedExternalId, externalId);
      assert.equal(payloadHash, event.payloadHash);
      return {
        status: "found",
        netsuiteId: 91_001,
        netsuiteReference: "SO91001",
        responseSnapshot: { id: 91_001, tranId: "SO91001", externalId }
      };
    }
  });
  assert.equal(lookupCalls, 1);
  assert.equal(resolution.resolution, "found");
  assert.equal(resolution.replayed, false);
  assert.equal(resolution.outbox.state, "reconciled");
  assert.equal(resolution.outbox.lookupRequired, false);
  assert.equal(resolution.outbox.netsuiteId, 91_001);
  assert.equal(resolution.outbox.netsuiteReference, "SO91001");
  assert.ok(resolution.outbox.externalAcknowledgedAt);
  assert.ok(resolution.outbox.reconciledAt);
  assert.equal(resolution.outbox.externalIdempotencyKey, event.externalIdempotencyKey);

  const attempts = await query(
    `SELECT attempt_number::int AS attempt_number, attempt_stage, outcome,
            netsuite_id, netsuite_reference, error_code
       FROM mbt_netsuite_outbox_attempts
      WHERE outbox_id = $1
      ORDER BY attempt_number`,
    [event.outboxId]
  );
  assert.deepEqual(attempts.rows, [
    {
      attempt_number: 1,
      attempt_stage: "send",
      outcome: "uncertain",
      netsuite_id: null,
      netsuite_reference: null,
      error_code: "CONNECTION_LOST_AFTER_SEND"
    },
    {
      attempt_number: 2,
      attempt_stage: "lookup",
      outcome: "succeeded",
      netsuite_id: "91001",
      netsuite_reference: "SO91001",
      error_code: null
    }
  ]);
  const reconciliation = await query(
    `SELECT status, netsuite_id, netsuite_reference,
            expected_snapshot, actual_snapshot, difference_snapshot
       FROM mbt_netsuite_reconciliations
      WHERE outbox_id = $1
      ORDER BY checked_at DESC
      LIMIT 1`,
    [event.outboxId]
  );
  assert.deepEqual(reconciliation.rows[0], {
    status: "matched",
    netsuite_id: "91001",
    netsuite_reference: "SO91001",
    expected_snapshot: event.payload,
    actual_snapshot: { id: 91_001, tranId: "SO91001", externalId },
    difference_snapshot: {}
  });
});

test("F12: only a definitive external-ID absence returns an uncertain create to pending", async () => {
  const resolveUncertainNetSuiteCreate = await repositoryFunction(
    "../../../src/mbt/outbox-repository.js",
    "resolveUncertainNetSuiteCreate"
  );
  const externalId = `mbt-absent-${RUN_ID}`;
  const { event } = await createUncertainOutbox("lookup_absent", externalId);
  const resolution = await resolveUncertainNetSuiteCreate({
    outboxId: event.outboxId,
    workerId: `p1-lookup-absent-${RUN_ID}`,
    retryAt: new Date(Date.now() - 1_000),
    lookupByExternalId: async () => ({
      status: "definitively_absent",
      responseSnapshot: { externalId, found: false, authoritative: true }
    })
  });
  assert.equal(resolution.resolution, "definitively_absent");
  assert.equal(resolution.outbox.state, "pending");
  assert.equal(resolution.outbox.lookupRequired, false);
  assert.equal(resolution.outbox.sentAt, null);
  assert.equal(resolution.outbox.externalIdempotencyKey, event.externalIdempotencyKey);
  assert.equal(resolution.outbox.payloadHash, event.payloadHash);

  const attempts = await query(
    `SELECT attempt_number::int AS attempt_number, attempt_stage, outcome, error_code
       FROM mbt_netsuite_outbox_attempts
      WHERE outbox_id = $1
      ORDER BY attempt_number`,
    [event.outboxId]
  );
  assert.deepEqual(attempts.rows, [
    {
      attempt_number: 1,
      attempt_stage: "send",
      outcome: "uncertain",
      error_code: "CONNECTION_LOST_AFTER_SEND"
    },
    {
      attempt_number: 2,
      attempt_stage: "lookup",
      outcome: "definitive_failure",
      error_code: "NETSUITE_EXTERNAL_ID_ABSENT"
    }
  ]);
  const retryClaim = await claimNextNetSuiteOutbox({
    workerId: `p1-retry-after-lookup-${RUN_ID}`,
    leaseSeconds: 30
  });
  assert.equal(retryClaim.outboxId, event.outboxId);
  assert.equal(retryClaim.attemptCount, 3);
  await query(
    `UPDATE mbt_netsuite_outbox
        SET state = 'voided', lease_token = NULL, lease_owner = NULL,
            lease_acquired_at = NULL, lease_expires_at = NULL
      WHERE outbox_id = $1`,
    [event.outboxId]
  );
});

test("F12: lookup failure remains attention and records unable-to-verify evidence", async () => {
  const resolveUncertainNetSuiteCreate = await repositoryFunction(
    "../../../src/mbt/outbox-repository.js",
    "resolveUncertainNetSuiteCreate"
  );
  const externalId = `mbt-lookup-error-${RUN_ID}`;
  const { event } = await createUncertainOutbox("lookup_error", externalId);
  const resolution = await resolveUncertainNetSuiteCreate({
    outboxId: event.outboxId,
    workerId: `p1-lookup-error-${RUN_ID}`,
    lookupByExternalId: async () => {
      const error = new Error("NetSuite lookup timed out.");
      error.code = "LOOKUP_TIMEOUT";
      throw error;
    }
  });
  assert.equal(resolution.resolution, "unable_to_verify");
  assert.equal(resolution.outbox.state, "attention");
  assert.equal(resolution.outbox.lookupRequired, true);
  assert.equal(resolution.outbox.attentionReason, "external_lookup_unable_to_verify");
  assert.equal(resolution.outbox.errorCode, "LOOKUP_TIMEOUT");

  const evidence = await query(
    `SELECT a.attempt_stage, a.outcome, a.error_code, a.error_message,
            r.status AS reconciliation_status, r.unable_to_verify_reason
       FROM mbt_netsuite_outbox_attempts a
       JOIN mbt_netsuite_reconciliations r ON r.outbox_id = a.outbox_id
      WHERE a.outbox_id = $1
        AND a.attempt_stage = 'lookup'`,
    [event.outboxId]
  );
  assert.deepEqual(evidence.rows[0], {
    attempt_stage: "lookup",
    outcome: "uncertain",
    error_code: "LOOKUP_TIMEOUT",
    error_message: "NetSuite lookup timed out.",
    reconciliation_status: "unable_to_verify",
    unable_to_verify_reason: "NetSuite lookup timed out."
  });
  const claim = await claimNextNetSuiteOutbox({ workerId: "must-not-retry-lookup-error", leaseSeconds: 30 });
  assert.notEqual(claim?.outboxId, event.outboxId);
});

test("F12: resolution rejects non-attention work and malformed lookup evidence without a create call", async () => {
  const resolveUncertainNetSuiteCreate = await repositoryFunction(
    "../../../src/mbt/outbox-repository.js",
    "resolveUncertainNetSuiteCreate"
  );
  const pending = await createOutbox("lookup_not_required", {
    externalId: `mbt-pending-${RUN_ID}`
  });
  await assert.rejects(
    () => resolveUncertainNetSuiteCreate({
      outboxId: pending.outboxId,
      workerId: `p1-invalid-lookup-${RUN_ID}`,
      lookupByExternalId: null
    }),
    { name: "TypeError", message: "A read-only NetSuite external-ID lookup is required." }
  );
  let lookupCalls = 0;
  const lookup = async () => {
    lookupCalls += 1;
    return { status: "definitively_absent" };
  };
  await assert.rejects(
    () => resolveUncertainNetSuiteCreate({
      outboxId: pending.outboxId,
      workerId: `p1-pending-lookup-${RUN_ID}`,
      lookupByExternalId: lookup
    }),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_OUTBOX_LOOKUP_NOT_REQUIRED"
  );
  await assert.rejects(
    () => resolveUncertainNetSuiteCreate({
      outboxId: crypto.randomUUID(),
      workerId: `p1-missing-lookup-${RUN_ID}`,
      lookupByExternalId: lookup
    }),
    (error) => error instanceof MbtError
      && error.status === 404
      && error.code === "MBT_OUTBOX_NOT_FOUND"
  );
  assert.equal(lookupCalls, 0);
  await query("UPDATE mbt_netsuite_outbox SET state = 'voided' WHERE outbox_id = $1", [pending.outboxId]);

  const externalId = `mbt-invalid-found-${RUN_ID}`;
  const { event } = await createUncertainOutbox("lookup_invalid_found", externalId);
  const invalid = await resolveUncertainNetSuiteCreate({
    outboxId: event.outboxId,
    workerId: `p1-invalid-found-${RUN_ID}`,
    lookupByExternalId: async () => ({
      status: "found",
      netsuiteId: 0,
      netsuiteReference: "SO-INVALID",
      responseSnapshot: { externalId }
    })
  });
  assert.equal(invalid.resolution, "unable_to_verify");
  assert.equal(invalid.outbox.state, "attention");
  assert.equal(invalid.outbox.lookupRequired, true);
  assert.equal(invalid.outbox.errorCode, "NETSUITE_LOOKUP_UNABLE_TO_VERIFY");
  assert.match(invalid.outbox.errorMessage, /positive integer NetSuite ID/i);
});

test("LC10/LC11: local-only billing approval commits one version, zero external work, and replays exactly", async () => {
  const approveMbtBillingCase = await repositoryFunction(
    "../../../src/mbt/billing-approval-repository.js",
    "approveMbtBillingCase"
  );
  const fixture = await createBillingFixture("supported_approval");
  const input = approvalInput(fixture);
  const first = await approveMbtBillingCase(input);
  const replay = await approveMbtBillingCase({
    ...input,
    calculationSnapshot: { lineCount: 1, source: "p1-billing-test" },
    sourceRevisionSnapshot: { billingRevision: 1 }
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.billingVersionId, replay.billingVersionId);
  assert.equal(first.versionNumber, 1);
  assert.equal(first.postingMode, "local_only");
  assert.equal(replay.postingMode, "local_only");
  assert.equal(first.outbox, null);
  assert.equal(replay.outbox, null);

  const state = await query(
    `SELECT b.status, b.posting_mode, b.revision::int AS revision, b.current_version_number,
            count(DISTINCT v.billing_version_id)::int AS versions,
            count(DISTINCT o.outbox_id)::int AS outbox_rows,
            count(DISTINCT sc.sales_order_chain_id)::int AS chain_rows,
            min(v.total_minor)::bigint AS total_minor,
            min(v.posting_mode) AS version_posting_mode
       FROM mbt_billing_cases b
       LEFT JOIN mbt_billing_versions v ON v.billing_case_id = b.billing_case_id
       LEFT JOIN mbt_netsuite_outbox o ON o.billing_version_id = v.billing_version_id
       LEFT JOIN mbt_netsuite_sales_order_chain sc ON sc.billing_version_id = v.billing_version_id
      WHERE b.billing_case_id = $1
      GROUP BY b.billing_case_id, b.posting_mode`,
    [fixture.billingCaseId]
  );
  assert.deepEqual(state.rows[0], {
    status: "approved",
    posting_mode: "local_only",
    revision: 2,
    current_version_number: 1,
    versions: 1,
    outbox_rows: 0,
    chain_rows: 0,
    total_minor: "11300",
    version_posting_mode: "local_only"
  });
});

test("LC10: approval snapshots caller-owned evidence before the first asynchronous wait", async () => {
  const approveMbtBillingCase = await repositoryFunction(
    "../../../src/mbt/billing-approval-repository.js",
    "approveMbtBillingCase"
  );
  const fixture = await createBillingFixture("approval_snapshot_detached");
  const input = approvalInput(fixture, {
    calculationSnapshot: {
      source: "call-time",
      nested: { quantity: 2 },
      lines: [{ code: "14YD", amountMinor: 10_000 }]
    },
    sourceRevisionSnapshot: {
      billingRevision: 1,
      sources: [{ entity: "contract", revision: 7 }]
    }
  });
  const expectedCalculation = structuredClone(input.calculationSnapshot);
  const expectedSource = structuredClone(input.sourceRevisionSnapshot);

  const pending = approveMbtBillingCase(input);
  input.calculationSnapshot.nested.quantity = 999;
  input.calculationSnapshot.lines[0].code = "MUTATED";
  input.sourceRevisionSnapshot.sources[0].revision = 999;
  await pending;

  const stored = await query(
    `SELECT calculation_snapshot, source_revision_snapshot
       FROM mbt_billing_versions
      WHERE billing_case_id = $1`,
    [fixture.billingCaseId]
  );
  assert.deepEqual(stored.rows, [{
    calculation_snapshot: expectedCalculation,
    source_revision_snapshot: expectedSource
  }]);

  const replay = await approveMbtBillingCase(approvalInput(fixture, {
    calculationSnapshot: expectedCalculation,
    sourceRevisionSnapshot: expectedSource
  }));
  assert.equal(replay.replayed, true);
});

test("LC10: draft and voided rows cannot masquerade as completed approval replays", async () => {
  const approveMbtBillingCase = await repositoryFunction(
    "../../../src/mbt/billing-approval-repository.js",
    "approveMbtBillingCase"
  );
  for (const status of ["draft", "voided"]) {
    const fixture = await createBillingFixture(`approval_non_final_${status}`);
    const input = approvalInput(fixture);
    await insertNonFinalApprovalVersion(fixture, input, status);
    await assert.rejects(
      () => approveMbtBillingCase({
        ...input,
        approvalReason: "Changed evidence must not hide a non-final row"
      }),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_BILLING_APPROVAL_NOT_FINAL"
    );
    await assert.rejects(
      () => approveMbtBillingCase(input),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_BILLING_APPROVAL_NOT_FINAL"
    );
    const state = await query(
      `SELECT b.status AS case_status, b.revision::int AS revision,
              b.current_version_number, v.status AS version_status
         FROM mbt_billing_cases b
         JOIN mbt_billing_versions v ON v.billing_case_id = b.billing_case_id
        WHERE b.billing_case_id = $1`,
      [fixture.billingCaseId]
    );
    assert.deepEqual(state.rows, [{
      case_status: "ready",
      revision: 1,
      current_version_number: 0,
      version_status: status
    }]);
  }
});

test("LC10: an exact approval replay remains stable after the billing case advances", async () => {
  const approveMbtBillingCase = await repositoryFunction(
    "../../../src/mbt/billing-approval-repository.js",
    "approveMbtBillingCase"
  );
  const fixture = await createBillingFixture("approval_stable_replay");
  const input = approvalInput(fixture);
  const first = await approveMbtBillingCase(input);
  await query(
    `UPDATE mbt_billing_cases
        SET status = 'posting', revision = 8, current_version_number = 7,
            posting_mode = 'netsuite_future', updated_at = clock_timestamp()
      WHERE billing_case_id = $1`,
    [fixture.billingCaseId]
  );

  const replay = await approveMbtBillingCase(input);
  assert.deepEqual({ ...replay, replayed: false }, first);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    () => approveMbtBillingCase({ ...input, expectedRevision: 8 }),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_BILLING_APPROVAL_IDENTITY_CONFLICT"
  );
  const durable = await query(
    `SELECT status, revision::int AS revision, current_version_number,
            posting_mode,
            (SELECT count(*)::int
               FROM mbt_billing_versions
              WHERE billing_case_id = $1) AS versions
       FROM mbt_billing_cases
      WHERE billing_case_id = $1`,
    [fixture.billingCaseId]
  );
  assert.deepEqual(durable.rows, [{
    status: "posting",
    revision: 8,
    current_version_number: 7,
    posting_mode: "netsuite_future",
    versions: 1
  }]);
});

test("LC11: local approval rejects an external payload before durable mutation", async () => {
  const approveMbtBillingCase = await repositoryFunction(
    "../../../src/mbt/billing-approval-repository.js",
    "approveMbtBillingCase"
  );
  const fixture = await createBillingFixture("supported_approval_rollback");
  await assert.rejects(
    () => approveMbtBillingCase(approvalInput(fixture, {
      outboxPayload: { forceAtomicRollback: true }
    })),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_LOCAL_POSTING_PAYLOAD_REFUSED"
  );

  const state = await query(
    `SELECT b.status, b.revision::int AS revision, b.current_version_number,
            (SELECT count(*)::int FROM mbt_billing_versions WHERE billing_case_id = b.billing_case_id) AS versions,
            (SELECT count(*)::int FROM mbt_netsuite_outbox WHERE billing_version_id = $2) AS outbox_rows
       FROM mbt_billing_cases b
      WHERE b.billing_case_id = $1`,
    [fixture.billingCaseId, fixture.billingVersionId]
  );
  assert.deepEqual(state.rows[0], {
    status: "ready",
    revision: 1,
    current_version_number: 0,
    versions: 0,
    outbox_rows: 0
  });
});

test("F12: malformed billing approvals and invalid case state fail before durable approval", async () => {
  const approveMbtBillingCase = await repositoryFunction(
    "../../../src/mbt/billing-approval-repository.js",
    "approveMbtBillingCase"
  );
  const fixture = await createBillingFixture("approval_validation");
  const valid = approvalInput(fixture);
  const malformed = [
    null,
    { ...valid, billingCaseId: "not-a-uuid" },
    { ...valid, expectedRevision: 0 },
    { ...valid, calculationSnapshot: [] },
    { ...valid, subtotalMinor: -1 },
    { ...valid, currency: "Canadian" },
    { ...valid, approvedBy: null },
    { ...valid, approvedBy: true },
    { ...valid, approvalReason: { unsafe: "object coercion" } },
    { ...valid, correlationId: 42 },
    { ...valid, idempotencyKey: false },
    { ...valid, outboxPayload: [] },
    { ...valid, subtotalMinor: Number.MAX_SAFE_INTEGER, estimatedTaxMinor: 1 }
  ];
  for (const input of malformed) {
    await assert.rejects(
      () => approveMbtBillingCase(input),
      (error) => error instanceof TypeError
    );
  }

  await assert.rejects(
    () => approveMbtBillingCase({ ...valid, expectedRevision: 2 }),
    (error) => error instanceof MbtError && error.code === "MBT_STALE_REVISION"
  );
  await assert.rejects(
    () => approveMbtBillingCase({ ...valid, currency: "USD" }),
    (error) => error instanceof MbtError && error.code === "MBT_BILLING_CURRENCY_MISMATCH"
  );
  await query("UPDATE mbt_billing_cases SET status = 'open' WHERE billing_case_id = $1", [fixture.billingCaseId]);
  await assert.rejects(
    () => approveMbtBillingCase(valid),
    (error) => error instanceof MbtError && error.code === "MBT_BILLING_NOT_APPROVABLE"
  );
  await assert.rejects(
    () => approveMbtBillingCase({ ...valid, billingCaseId: crypto.randomUUID() }),
    (error) => error instanceof MbtError
      && error.status === 404
      && error.code === "MBT_BILLING_CASE_NOT_FOUND"
  );

  const state = await query(
    `SELECT b.status, b.revision::int AS revision,
            (SELECT count(*)::int FROM mbt_billing_versions WHERE billing_case_id = b.billing_case_id) AS versions,
            (SELECT count(*)::int FROM mbt_netsuite_outbox WHERE billing_version_id = $2) AS outbox_rows
       FROM mbt_billing_cases b
      WHERE b.billing_case_id = $1`,
    [fixture.billingCaseId, fixture.billingVersionId]
  );
  assert.deepEqual(state.rows[0], {
    status: "open",
    revision: 1,
    versions: 0,
    outbox_rows: 0
  });
});

test("LC10/LC11: in-review local approval has no payload and rejects changed replay identity", async () => {
  const approveMbtBillingCase = await repositoryFunction(
    "../../../src/mbt/billing-approval-repository.js",
    "approveMbtBillingCase"
  );
  const fixture = await createBillingFixture("approval_in_review");
  await query("UPDATE mbt_billing_cases SET status = 'in_review' WHERE billing_case_id = $1", [fixture.billingCaseId]);
  const withoutOutboxPayload = approvalInput(fixture);
  delete withoutOutboxPayload.outboxPayload;
  const approved = await approveMbtBillingCase(withoutOutboxPayload);
  assert.equal(approved.billingCaseStatus, "approved");
  assert.equal(approved.postingMode, "local_only");
  assert.equal(approved.outbox, null);
  await assert.rejects(
    () => approveMbtBillingCase({
      ...withoutOutboxPayload,
      outboxPayload: { memo: "changed replay" }
    }),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_LOCAL_POSTING_PAYLOAD_REFUSED"
  );
  await assert.rejects(
    () => approveMbtBillingCase({
      ...withoutOutboxPayload,
      approvalReason: "A different approval decision"
    }),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_BILLING_APPROVAL_IDENTITY_CONFLICT"
  );
  const counts = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_billing_versions WHERE billing_case_id = $1) AS versions,
       (SELECT count(*)::int FROM mbt_netsuite_outbox WHERE billing_version_id = $2) AS outbox_rows`,
    [fixture.billingCaseId, approved.billingVersionId]
  );
  assert.deepEqual(counts.rows[0], { versions: 1, outbox_rows: 0 });
});

test("LC10/LC11: future NetSuite intent is frozen but remains quiet in this phase", async () => {
  const approveMbtBillingCase = await repositoryFunction(
    "../../../src/mbt/billing-approval-repository.js",
    "approveMbtBillingCase"
  );
  const fixture = await createBillingFixture("approval_future_intent", {
    postingMode: "netsuite_future"
  });
  const approved = await approveMbtBillingCase(approvalInput(fixture));
  assert.equal(approved.postingMode, "netsuite_future");
  assert.equal(approved.outbox, null);
  const state = await query(
    `SELECT b.posting_mode,
            v.posting_mode AS version_posting_mode,
            (SELECT count(*)::int FROM mbt_netsuite_outbox WHERE billing_version_id = v.billing_version_id) AS outbox_rows,
            (SELECT count(*)::int FROM mbt_netsuite_sales_order_chain WHERE billing_version_id = v.billing_version_id) AS chain_rows
       FROM mbt_billing_cases b
       JOIN mbt_billing_versions v ON v.billing_case_id = b.billing_case_id
      WHERE b.billing_case_id = $1`,
    [fixture.billingCaseId]
  );
  assert.deepEqual(state.rows[0], {
    posting_mode: "netsuite_future",
    version_posting_mode: "netsuite_future",
    outbox_rows: 0,
    chain_rows: 0
  });
});

test("LC10: every newly written billing version requires immutable prior-revision evidence", async () => {
  const fixture = await createBillingFixture("approval_revision_evidence_guard");
  const input = approvalInput(fixture);
  await assert.rejects(
    () => query(
      `INSERT INTO mbt_billing_versions (
         billing_version_id, billing_case_id, version_number, status,
         rate_card_version_id, calculation_snapshot, source_revision_snapshot,
         subtotal_minor, estimated_tax_minor, total_minor, currency,
         posting_mode, approved_by, approval_reason, approved_at,
         correlation_id, idempotency_key
       ) VALUES (
         $1, $2, 1, 'draft', $3, $4::jsonb, $5::jsonb,
         $6, $7, $8, $9, $10, $11, $12, clock_timestamp(), $13, $14
       )`,
      [
        crypto.randomUUID(),
        fixture.billingCaseId,
        input.rateCardVersionId,
        JSON.stringify(input.calculationSnapshot),
        JSON.stringify(input.sourceRevisionSnapshot),
        input.subtotalMinor,
        input.estimatedTaxMinor,
        input.subtotalMinor + input.estimatedTaxMinor,
        input.currency,
        fixture.postingMode,
        input.approvedBy,
        input.approvalReason,
        input.correlationId,
        input.idempotencyKey
      ]
    ),
    (error) => error?.code === "23514"
      && error?.constraint === "mbt_billing_versions_revision_evidence_required"
  );
  const count = await query(
    "SELECT count(*)::int AS rows FROM mbt_billing_versions WHERE billing_case_id = $1",
    [fixture.billingCaseId]
  );
  assert.deepEqual(count.rows, [{ rows: 0 }]);
});

test("LC11 defense in depth: local-only versions cannot be enqueued directly", async () => {
  const approveMbtBillingCase = await repositoryFunction(
    "../../../src/mbt/billing-approval-repository.js",
    "approveMbtBillingCase"
  );
  const fixture = await createBillingFixture("approval_local_guard");
  const approved = await approveMbtBillingCase(approvalInput(fixture));
  await assert.rejects(
    () => enqueueNetSuiteOutbox({
      externalIdempotencyKey: `forbidden-local-${fixture.key}`,
      operationType: "create_sales_order",
      targetRecordType: "sales_order",
      payload: { externalId: `forbidden-local-${fixture.key}` },
      billingVersionId: approved.billingVersionId
    }),
    (error) => error?.code === "23514"
      && error?.constraint === "mbt_local_only_outbox_work"
  );
  const count = await query(
    "SELECT count(*)::int AS rows FROM mbt_netsuite_outbox WHERE billing_version_id = $1",
    [approved.billingVersionId]
  );
  assert.deepEqual(count.rows[0], { rows: 0 });
});

test("LC11 defense in depth: disguised outbox work and Sales Order chain repointing cannot bypass local-only intent", async () => {
  const approveMbtBillingCase = await repositoryFunction(
    "../../../src/mbt/billing-approval-repository.js",
    "approveMbtBillingCase"
  );
  const localFixture = await createBillingFixture("approval_local_db_guards");
  const localApproval = await approveMbtBillingCase(approvalInput(localFixture));

  await assert.rejects(
    () => query(
      `INSERT INTO mbt_netsuite_outbox (
         outbox_id, external_idempotency_key, operation_type,
         target_record_type, payload, payload_hash, billing_version_id
       ) VALUES ($1, $2, 'create_sales_order', 'file', '{}'::jsonb, $3, $4)`,
      [
        crypto.randomUUID(),
        `disguised-local-${localFixture.key}`,
        HASH,
        localApproval.billingVersionId
      ]
    ),
    (error) => error?.code === "23514"
      && error?.constraint === "mbt_local_only_outbox_work"
  );
  await assert.rejects(
    () => query(
      `INSERT INTO mbt_netsuite_sales_order_chain (
         sales_order_chain_id, order_kind, contract_id,
         customer_netsuite_id, subsidiary_netsuite_id, sequence_number,
         billing_version_id, external_idempotency_key
       ) VALUES ($1, 'mbt_customer', $2, $3, 33, 1, $4, $5)`,
      [
        crypto.randomUUID(),
        localFixture.contractId,
        localFixture.customerId,
        localApproval.billingVersionId,
        `local-chain-${localFixture.key}`
      ]
    ),
    (error) => error?.code === "23514"
      && error?.constraint === "mbt_local_only_sales_order_chain"
  );

  const futureFixture = await createBillingFixture("approval_future_chain_guard", {
    postingMode: "netsuite_future"
  });
  const futureApproval = await approveMbtBillingCase(approvalInput(futureFixture));
  const futureChainId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_netsuite_sales_order_chain (
       sales_order_chain_id, order_kind, contract_id,
       customer_netsuite_id, subsidiary_netsuite_id, sequence_number,
       billing_version_id, external_idempotency_key
     ) VALUES ($1, 'mbt_customer', $2, $3, 33, 1, $4, $5)`,
    [
      futureChainId,
      futureFixture.contractId,
      futureFixture.customerId,
      futureApproval.billingVersionId,
      `future-chain-${futureFixture.key}`
    ]
  );
  await assert.rejects(
    () => query(
      `UPDATE mbt_netsuite_sales_order_chain
          SET billing_version_id = $2
        WHERE sales_order_chain_id = $1`,
      [futureChainId, localApproval.billingVersionId]
    ),
    (error) => error?.code === "23514"
      && error?.constraint === "mbt_local_only_sales_order_chain"
  );
  const durable = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_netsuite_outbox
         WHERE billing_version_id = $1) AS local_outbox,
       (SELECT count(*)::int
          FROM mbt_netsuite_sales_order_chain
         WHERE billing_version_id = $1) AS local_chains,
       (SELECT billing_version_id::text
          FROM mbt_netsuite_sales_order_chain
         WHERE sales_order_chain_id = $2) AS retained_future_version`,
    [localApproval.billingVersionId, futureChainId]
  );
  assert.deepEqual(durable.rows[0], {
    local_outbox: 0,
    local_chains: 0,
    retained_future_version: futureApproval.billingVersionId
  });
});

test("F13: current mapping hash, read-only checks, and completed evidence are deterministic and persisted", async () => {
  const mapping = await insertMapping({
    label: "preflight_pass",
    mappingType: "subsidiary",
    externalRecordType: "subsidiary",
    externalId: "33"
  });
  const firstConfiguration = await getCurrentNetSuiteConfiguration();
  const secondConfiguration = await getCurrentNetSuiteConfiguration();
  assert.equal(firstConfiguration.configurationHash, secondConfiguration.configurationHash);
  assert.equal(
    firstConfiguration.configurationHash,
    configurationHash([...firstConfiguration.mappings].reverse())
  );
  assert.ok(firstConfiguration.mappings.some((entry) => entry.mappingId === mapping.mappingId));

  const tracked = trackedAdapter(async (recordType, externalId) => ({
    recordType,
    id: externalId,
    active: true,
    accountId: "P1_TEST_ACCOUNT",
    subsidiaryId: 33
  }));
  const result = await runNetSuitePreflight(preflightInput(
    tracked.adapter,
    [requirement(mapping, "subsidiary")]
  ));
  assert.equal(result.status, "passed");
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.configurationHash, firstConfiguration.configurationHash);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].status, "passed");
  assert.deepEqual(tracked.counts, { reads: 1, writes: 0 });

  const persisted = await query(
    `SELECT r.configuration_hash, r.mapping_snapshot, r.adapter_kind,
            r.account_id, r.environment_name, r.status,
            r.required_check_count, r.passed_required_count,
            r.failed_required_count, c.check_type, c.status AS check_status
       FROM mbt_netsuite_preflight_runs r
       JOIN mbt_netsuite_preflight_checks c
         ON c.preflight_run_id = r.preflight_run_id
      WHERE r.preflight_run_id = $1`,
    [result.preflightRunId]
  );
  assert.equal(persisted.rowCount, 1);
  assert.equal(persisted.rows[0].configuration_hash, result.configurationHash);
  assert.ok(Array.isArray(persisted.rows[0].mapping_snapshot));
  assert.deepEqual({
    adapterKind: persisted.rows[0].adapter_kind,
    accountId: persisted.rows[0].account_id,
    environmentName: persisted.rows[0].environment_name,
    status: persisted.rows[0].status,
    required: persisted.rows[0].required_check_count,
    passed: persisted.rows[0].passed_required_count,
    failed: persisted.rows[0].failed_required_count,
    checkType: persisted.rows[0].check_type,
    checkStatus: persisted.rows[0].check_status
  }, {
    adapterKind: "phase1_read_only_fake",
    accountId: "P1_TEST_ACCOUNT",
    environmentName: "test",
    status: "passed",
    required: 1,
    passed: 1,
    failed: 0,
    checkType: "subsidiary",
    checkStatus: "passed"
  });
  assert.deepEqual(await getNetSuitePreflightReadiness(result.preflightRunId), {
    ready: true,
    reasons: [],
    status: "passed",
    configurationHash: result.configurationHash,
    currentConfigurationHash: result.configurationHash
  });
});

test("F13: malformed preflight requests create no evidence and unknown run IDs fail closed", async () => {
  const tracked = trackedAdapter(async () => {
    throw new Error("Malformed preflight input must fail before any adapter read.");
  });
  const oneRequirement = {
    checkType: "input_contract",
    mappingType: "subsidiary",
    localKey: identity("input_contract").localKey,
    required: true
  };
  const malformed = [
    preflightInput({}, [oneRequirement]),
    preflightInput(tracked.adapter, [oneRequirement], { adapterKind: null }),
    preflightInput(tracked.adapter, []),
    preflightInput(tracked.adapter, [oneRequirement, { ...oneRequirement }])
  ];
  for (const input of malformed) {
    await assert.rejects(
      () => runNetSuitePreflight(input),
      (error) => error instanceof TypeError
    );
  }
  assert.deepEqual(tracked.counts, { reads: 0, writes: 0 });
  const persisted = await query(
    `SELECT count(*)::int AS count
       FROM mbt_netsuite_preflight_runs
      WHERE correlation_id = ANY($1::text[])`,
    [malformed.map(({ correlationId }) => correlationId)]
  );
  assert.equal(persisted.rows[0].count, 0);

  await assert.rejects(
    () => getNetSuitePreflightReadiness(crypto.randomUUID()),
    (error) => error instanceof MbtError
      && error.status === 404
      && error.code === "MBT_PREFLIGHT_NOT_FOUND"
  );
});

test("F13: mapping and adapter edge states persist precise fail-closed evidence", async () => {
  const optionalGlobal = await insertMapping({
    label: "preflight_optional_global",
    mappingType: "custom_field",
    externalRecordType: "customrecordtype",
    externalId: "custrecord_mbt_global",
    externalScriptId: "custrecord_mbt_global",
    subsidiaryNetSuiteId: null
  });
  const inactiveMapping = await insertMapping({
    label: "preflight_inactive_mapping",
    mappingType: "payment_account",
    externalRecordType: "account",
    externalId: "5100",
    active: false
  });
  const unverifiableMapping = await insertMapping({
    label: "preflight_unverifiable_mapping",
    mappingType: "transaction_identifier",
    externalRecordType: "customrecordtype",
    externalId: "custrecord_unverifiable",
    validationStatus: "unable_to_verify"
  });
  const validationInactive = await insertMapping({
    label: "preflight_validation_inactive",
    mappingType: "payment_method",
    externalRecordType: "paymentmethod",
    externalId: "7",
    validationStatus: "inactive"
  });
  const permissionMapping = await insertMapping({
    label: "preflight_permission",
    mappingType: "integration_permission",
    externalRecordType: "role",
    externalId: "1042"
  });
  const missingRecordMapping = await insertMapping({
    label: "preflight_missing_record",
    mappingType: "file_cabinet_folder",
    externalRecordType: "folder",
    externalId: "880"
  });
  const inactiveRecordMapping = await insertMapping({
    label: "preflight_inactive_record",
    mappingType: "tax_code",
    externalRecordType: "salestaxitem",
    externalId: "13"
  });
  const current = await getCurrentNetSuiteConfiguration();
  const projected = current.mappings.find(({ mappingId }) => mappingId === optionalGlobal.mappingId);
  assert.equal(projected.externalScriptId, "custrecord_mbt_global");
  assert.equal(projected.subsidiaryNetSuiteId, null);

  const tracked = trackedAdapter(async (_recordType, externalId) => {
    if (externalId === permissionMapping.externalId) {
      throw { status: 403, code: "INSUFFICIENT_PERMISSION" };
    }
    if (externalId === missingRecordMapping.externalId) {
      return null;
    }
    if (externalId === inactiveRecordMapping.externalId) {
      return { id: externalId, active: false, subsidiaryId: 33 };
    }
    return { id: externalId, active: true };
  });
  const result = await runNetSuitePreflight(preflightInput(tracked.adapter, [
    {
      checkType: "optional_global_mapping",
      mappingType: optionalGlobal.mappingType,
      localKey: optionalGlobal.localKey,
      required: false
    },
    requirement(inactiveMapping, "inactive_mapping"),
    requirement(unverifiableMapping, "unverifiable_mapping"),
    requirement(validationInactive, "validation_inactive"),
    requirement(permissionMapping, "permission_denied"),
    requirement(missingRecordMapping, "record_missing"),
    requirement(inactiveRecordMapping, "record_inactive")
  ]));

  assert.equal(result.status, "unable_to_verify");
  assert.equal(result.ready, false);
  assert.deepEqual(result.checks.map(({ checkType, status }) => [checkType, status]), [
    ["optional_global_mapping", "passed"],
    ["inactive_mapping", "inactive"],
    ["unverifiable_mapping", "unable_to_verify"],
    ["validation_inactive", "inactive"],
    ["permission_denied", "permission_denied"],
    ["record_missing", "unable_to_verify"],
    ["record_inactive", "inactive"]
  ]);
  assert.deepEqual(tracked.counts, { reads: 4, writes: 0 });
  assert.ok(result.reasons.includes("permission_denied:permission_denied"), JSON.stringify(result));
  assert.ok(result.reasons.includes("unable_to_verify:record_missing"), JSON.stringify(result));

  const persisted = await query(
    `SELECT required_check_count, passed_required_count, failed_required_count,
            optional_check_count, passed_optional_count, error_code
       FROM mbt_netsuite_preflight_runs
      WHERE preflight_run_id = $1`,
    [result.preflightRunId]
  );
  assert.deepEqual(persisted.rows[0], {
    required_check_count: 6,
    passed_required_count: 0,
    failed_required_count: 6,
    optional_check_count: 1,
    passed_optional_count: 1,
    error_code: "MBT_PREFLIGHT_UNABLE_TO_VERIFY"
  });
});

test("F13: missing and invalid required mappings fail closed without any adapter call", async () => {
  const invalid = await insertMapping({
    label: "preflight_invalid",
    mappingType: "sales_order_form",
    externalRecordType: "customform",
    externalId: "81",
    validationStatus: "invalid"
  });
  const missing = {
    mappingType: "income_account",
    localKey: identity("preflight_missing").localKey
  };
  const tracked = trackedAdapter(async () => {
    throw new Error("Invalid or missing mappings must fail before adapter reads.");
  });
  const result = await runNetSuitePreflight(preflightInput(tracked.adapter, [
    requirement(invalid, "invalid_mapping"),
    requirement(missing, "missing_mapping")
  ]));

  assert.equal(result.status, "failed");
  assert.equal(result.ready, false);
  assert.deepEqual(result.checks.map(({ checkType, status }) => [checkType, status]), [
    ["invalid_mapping", "invalid"],
    ["missing_mapping", "missing"]
  ]);
  assert.deepEqual(tracked.counts, { reads: 0, writes: 0 });
  const readiness = await getNetSuitePreflightReadiness(result.preflightRunId);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.reasons.includes("invalid:invalid_mapping"), JSON.stringify(readiness));
  assert.ok(readiness.reasons.includes("missing:missing_mapping"), JSON.stringify(readiness));
});

test("F13: a mapping revision change makes a previously passed preflight stale", async () => {
  const mapping = await insertMapping({
    label: "preflight_stale",
    mappingType: "income_account",
    externalRecordType: "account",
    externalId: "4100"
  });
  const tracked = trackedAdapter(async (_recordType, externalId) => ({
    id: externalId,
    active: true,
    accountId: "P1_TEST_ACCOUNT",
    subsidiaryId: 33
  }));
  const passed = await runNetSuitePreflight(preflightInput(
    tracked.adapter,
    [requirement(mapping, "income_account")]
  ));
  assert.equal(passed.ready, true);

  await query(
    `UPDATE mbt_netsuite_mappings
        SET active = false, is_current = false, updated_at = now()
      WHERE mapping_id = $1`,
    [mapping.mappingId]
  );
  const replacement = await insertMapping({
    label: "preflight_stale_replacement",
    mappingType: mapping.mappingType,
    localKey: mapping.localKey,
    externalRecordType: mapping.externalRecordType,
    externalId: "4101",
    revision: 2
  });
  assert.equal(replacement.localKey, mapping.localKey);
  const readiness = await getNetSuitePreflightReadiness(passed.preflightRunId);
  assert.equal(readiness.ready, false);
  assert.notEqual(readiness.currentConfigurationHash, passed.configurationHash);
  assert.ok(readiness.reasons.includes("configuration_changed"), JSON.stringify(readiness));
});

test("F13/F15: production, account, and subsidiary mismatch evidence fails closed with zero write calls", async () => {
  const mapping = await insertMapping({
    label: "preflight_mismatch",
    mappingType: "intercompany_customer",
    externalRecordType: "customer",
    externalId: "33"
  });
  const productionTracked = trackedAdapter(async () => {
    throw new Error("The Phase 1 fake adapter must not contact production.");
  });
  const production = await runNetSuitePreflight(preflightInput(
    productionTracked.adapter,
    [requirement(mapping, "production_environment")],
    { environmentName: "production" }
  ));
  assert.equal(production.status, "unable_to_verify");
  assert.equal(production.ready, false);
  assert.equal(production.checks[0].status, "unable_to_verify");
  assert.deepEqual(productionTracked.counts, { reads: 0, writes: 0 });

  const adapterKindTracked = trackedAdapter(async () => {
    throw new Error("Phase 1 must reject non-fake adapter kinds before record reads.");
  });
  const adapterKind = await runNetSuitePreflight(preflightInput(
    adapterKindTracked.adapter,
    [requirement(mapping, "adapter_kind")],
    { adapterKind: "read_only_sandbox" }
  ));
  assert.equal(adapterKind.status, "unable_to_verify");
  assert.equal(adapterKind.ready, false);
  assert.equal(adapterKind.checks[0].status, "unable_to_verify");
  assert.deepEqual(adapterKindTracked.counts, { reads: 0, writes: 0 });

  const accountTracked = trackedAdapter(async () => {
    throw new Error("An account mismatch must fail before record reads.");
  });
  const account = await runNetSuitePreflight(preflightInput(
    accountTracked.adapter,
    [requirement(mapping, "account_identity")],
    { accountId: "WRONG_ACCOUNT" }
  ));
  assert.equal(account.status, "unable_to_verify");
  assert.equal(account.ready, false);
  assert.equal(account.checks[0].status, "unable_to_verify");
  assert.deepEqual(accountTracked.counts, { reads: 0, writes: 0 });

  const subsidiaryTracked = trackedAdapter(async (_recordType, externalId) => ({
    id: externalId,
    active: true,
    accountId: "P1_TEST_ACCOUNT",
    subsidiaryId: 999
  }));
  const subsidiary = await runNetSuitePreflight(preflightInput(
    subsidiaryTracked.adapter,
    [requirement(mapping, "subsidiary_identity", 33)]
  ));
  assert.equal(subsidiary.status, "failed");
  assert.equal(subsidiary.ready, false);
  assert.equal(subsidiary.checks[0].status, "wrong_subsidiary");
  assert.deepEqual(subsidiaryTracked.counts, { reads: 1, writes: 0 });

  const persisted = await query(
    `SELECT status, error_code
      FROM mbt_netsuite_preflight_runs
      WHERE preflight_run_id = ANY($1::uuid[])
      ORDER BY preflight_run_id`,
    [[production.preflightRunId, adapterKind.preflightRunId, account.preflightRunId, subsidiary.preflightRunId]]
  );
  assert.equal(persisted.rowCount, 4);
  assert.ok(persisted.rows.every(({ status }) => status !== "passed"));
});
