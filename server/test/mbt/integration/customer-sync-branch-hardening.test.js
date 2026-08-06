// @ts-check

/**
 * Executable persistence specification:
 *
 * - sparse canonical DTOs use documented defaults while retaining bigint IDs;
 * - exact command replay is side-effect free and changed-payload replay fails;
 * - an inactive observation removes only the Returns projection and publishes
 *   durable inactivation evidence;
 * - complete full snapshots derive a stable cursor and inactivate missing
 *   account customers exactly once;
 * - fresh incremental syncs start without a cursor and persist their next one;
 * - source failures and lost leases cannot mutate canonical customer state.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, pool, query } from "../../../src/db.js";
import {
  applyCanonicalCustomerAggregates,
  readCustomerProvenance,
  runCustomerSync
} from "../../../src/mbt/customer-sync-service.js";
import { MbtError } from "../../../src/mbt/errors.js";

const SUFFIX = crypto.randomUUID().replaceAll("-", "");
const BASE_ID = 410_000_000 + Number.parseInt(SUFFIX.slice(0, 6), 16);
const SUBSIDIARY_ID = 510_000_000 + Number.parseInt(SUFFIX.slice(6, 12), 16);
const BIG_ID = String(9_007_200_000_000_000n + BigInt(Number.parseInt(SUFFIX.slice(12, 18), 16)));
const MODIFIED_A = "2026-08-04T10:00:00.000Z";
const MODIFIED_B = "2026-08-04T11:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** @param {unknown} value */
function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** @param {number | string} netsuiteId @param {Record<string, unknown>} [overrides] */
function customer(netsuiteId, overrides = {}) {
  const marker = String(netsuiteId);
  const value = {
    netsuiteId,
    entityNumber: `BR-${marker}`,
    legalName: `Branch Legal ${marker}`,
    displayName: `Branch Customer ${marker}`,
    currency: "CAD",
    terms: "NET30",
    taxStatus: "taxable",
    creditStatus: "good",
    email: `branch-${marker}@example.invalid`,
    phone: "5195550100",
    active: true,
    sourceKind: "netsuite_read",
    sourceAccountId: `BRANCH_ACCOUNT_${SUFFIX}`,
    sourceModifiedAt: MODIFIED_A,
    sourceVersion: `branch-v1-${marker}`,
    subsidiaries: [],
    addresses: [],
    contacts: [],
    ...overrides
  };
  return { ...value, payloadHash: overrides.payloadHash || digest(value) };
}

/**
 * @param {string} label
 * @param {Record<string, unknown>[]} aggregates
 * @param {Record<string, unknown>} [overrides]
 */
function applyCommand(label, aggregates, overrides = {}) {
  return {
    accountId: `BRANCH_ACCOUNT_${SUFFIX}`,
    subsidiaryId: SUBSIDIARY_ID,
    sourceKind: "netsuite_read",
    sourceAsOf: MODIFIED_A,
    sourceVersion: `apply-${label}`,
    aggregates,
    correlationId: `branch-apply-correlation-${SUFFIX}-${label}`,
    requestId: `branch-apply-request-${SUFFIX}-${label}`,
    idempotencyKey: `branch-apply-key-${SUFFIX}-${label}`,
    actorId: `branch-apply-admin-${SUFFIX}`,
    reason: `Branch coverage ${label}`,
    ...overrides
  };
}

/**
 * @param {string} label
 * @param {{fetchPage: (input: Record<string, unknown>) => Promise<unknown>}} source
 * @param {Record<string, unknown>} [overrides]
 */
function syncCommand(label, source, overrides = {}) {
  return {
    syncKey: `branch-sync-${SUFFIX}-${label}`,
    accountId: `BRANCH_SYNC_ACCOUNT_${SUFFIX}_${label}`,
    subsidiaryId: SUBSIDIARY_ID,
    syncKind: "full_reconciliation",
    sourceKind: "netsuite_read",
    correlationId: `branch-sync-correlation-${SUFFIX}-${label}`,
    requestedBy: `branch-sync-admin-${SUFFIX}`,
    pageSize: 10,
    source,
    ...overrides
  };
}

after(async () => {
  await closeDb();
});

test("sparse canonical aggregate persists normalized DTO defaults, children, audit, and exact replay", async () => {
  const sparse = {
    netsuiteId: BIG_ID,
    entityNumber: `BR-BIG-${SUFFIX}`,
    legalName: "Sparse Branch Legal",
    displayName: "Sparse Branch Customer",
    currency: "cad",
    taxStatus: null,
    creditStatus: 7,
    email: null,
    sourceModifiedAt: MODIFIED_A,
    sourceVersion: `sparse-v1-${SUFFIX}`,
    payloadHash: HASH_A,
    subsidiaries: [{
      netsuiteId: SUBSIDIARY_ID,
      primary: false,
      currency: null,
      taxStatus: null,
      active: false
    }],
    addresses: [{
      netsuiteAddressId: `SPARSE-ADDRESS-${SUFFIX}`,
      label: null,
      billingDefault: false,
      shippingDefault: false,
      attention: null,
      addressLine2: null,
      city: null,
      postalCode: null,
      countryCode: "ca",
      active: false
    }],
    contacts: [{
      netsuiteContactId: `SPARSE-CONTACT-${SUFFIX}`,
      displayName: "Sparse Contact",
      firstName: null,
      jobTitle: null,
      phone: null,
      primary: false,
      active: false
    }]
  };
  const command = applyCommand("sparse", [sparse], {
    subsidiaryId: null,
    sourceKind: "customer_master_event"
  });
  const first = await applyCanonicalCustomerAggregates(pool, command);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.outcomes, [{ customerNetSuiteId: BIG_ID, action: "created" }]);
  assert.equal(first.created, 1);

  const replay = await applyCanonicalCustomerAggregates(pool, structuredClone(command));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);

  const stored = await query(
    `SELECT
       c.netsuite_id::text, c.currency, c.terms, c.tax_status,
       c.credit_status, c.email, c.phone, c.active,
       s.relationship_name, s.primary_relationship, s.currency AS subsidiary_currency,
       s.terms AS subsidiary_terms, s.active AS subsidiary_active,
       a.label, a.addressee, a.attention, a.address_line_1, a.address_line_2,
       a.address_line_3, a.city, a.region, a.postal_code, a.country_code,
       a.phone AS address_phone, a.active AS address_active,
       p.source_kind, p.source_account_id, p.last_live_netsuite_observation_at,
       n.first_name, n.last_name, n.job_title, n.email AS contact_email,
       n.phone AS contact_phone, n.mobile_phone, n.primary_contact,
       n.active AS contact_active
      FROM netsuite_customers c
      JOIN netsuite_customer_subsidiaries s ON s.customer_netsuite_id = c.netsuite_id
      JOIN netsuite_customer_addresses a ON a.customer_netsuite_id = c.netsuite_id
      JOIN netsuite_customer_contacts n ON n.customer_netsuite_id = c.netsuite_id
      JOIN mbt_customer_provenance p ON p.customer_netsuite_id = c.netsuite_id
     WHERE c.netsuite_id = $1`,
    [BIG_ID]
  );
  assert.deepEqual(stored.rows[0], {
    netsuite_id: BIG_ID,
    currency: "CAD",
    terms: null,
    tax_status: null,
    credit_status: "7",
    email: "",
    phone: "",
    active: true,
    relationship_name: "",
    primary_relationship: false,
    subsidiary_currency: null,
    subsidiary_terms: null,
    subsidiary_active: false,
    label: "",
    addressee: "",
    attention: "",
    address_line_1: "",
    address_line_2: "",
    address_line_3: "",
    city: "",
    region: "",
    postal_code: "",
    country_code: "CA",
    address_phone: "",
    address_active: false,
    source_kind: "customer_master_event",
    source_account_id: `BRANCH_ACCOUNT_${SUFFIX}`,
    last_live_netsuite_observation_at: null,
    first_name: "",
    last_name: "",
    job_title: "",
    contact_email: "",
    contact_phone: "",
    mobile_phone: "",
    primary_contact: false,
    contact_active: false
  });

  assert.deepEqual(await readCustomerProvenance(pool, BIG_ID), {
    customerNetSuiteId: BIG_ID,
    sourceKind: "customer_master_event",
    sourceAccountId: `BRANCH_ACCOUNT_${SUFFIX}`,
    sourceVersion: `sparse-v1-${SUFFIX}`,
    lastLiveNetSuiteObservationAt: null
  });
  assert.equal(await readCustomerProvenance(pool, BASE_ID + 90_000), null);

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1 AND idempotency_key = $2) AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND idempotency_key = $2) AS audits,
       (SELECT request_id FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND idempotency_key = $2) AS request_id,
       (SELECT reason FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND idempotency_key = $2) AS reason`,
    [command.actorId, command.idempotencyKey]
  );
  assert.deepEqual(evidence.rows[0], {
    receipts: 1,
    audits: 1,
    request_id: command.requestId,
    reason: command.reason
  });

  await assert.rejects(
    applyCanonicalCustomerAggregates(pool, { ...command, reason: "Changed replay payload" }),
    (error) => error instanceof MbtError && error.code === "MBT_IDEMPOTENCY_CONFLICT"
  );
  const afterConflict = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1 AND idempotency_key = $2) AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND idempotency_key = $2) AS audits`,
    [command.actorId, command.idempotencyKey]
  );
  assert.deepEqual(afterConflict.rows[0], { receipts: 1, audits: 1 });
});

test("newer inactive observation removes the Returns projection and emits one inactivation event", async () => {
  const id = BASE_ID + 1;
  const active = customer(id, { addresses: [{
    netsuiteAddressId: `ACTIVE-ADDRESS-${SUFFIX}`,
    label: "Active address",
    shippingDefault: true,
    addressLine1: "1 Branch Street",
    city: "Toronto",
    region: "ON",
    postalCode: "A1A 1A1",
    countryCode: "CA"
  }] });
  const activeResult = await applyCanonicalCustomerAggregates(
    pool,
    applyCommand("active-before-inactivate", [active])
  );
  assert.equal(activeResult.created, 1);

  const inactive = customer(id, {
    ...active,
    active: false,
    sourceModifiedAt: MODIFIED_B,
    sourceVersion: `inactive-v2-${SUFFIX}`,
    payloadHash: HASH_B
  });
  const inactiveResult = await applyCanonicalCustomerAggregates(
    pool,
    applyCommand("inactive", [inactive])
  );
  assert.equal(inactiveResult.updated, 1);
  const stored = await query(
    `SELECT
       (SELECT active FROM netsuite_customers WHERE netsuite_id = $1) AS active,
       (SELECT count(*)::int FROM return_customer_directory
         WHERE netsuite_customer_id = $1) AS return_rows,
       (SELECT array_agg(change_type ORDER BY sequence_id)
          FROM mbt_customer_master_events WHERE customer_netsuite_id = $1) AS changes`,
    [id]
  );
  assert.deepEqual(stored.rows[0], {
    active: false,
    return_rows: 0,
    changes: ["upsert", "inactivate"]
  });
});

test("full snapshot derives its cursor and inactivates a missing account customer exactly once", async () => {
  const accountId = `BRANCH_FULL_ACCOUNT_${SUFFIX}`;
  const leftId = BASE_ID + 20;
  const rightId = BASE_ID + 21;
  const left = customer(leftId, { sourceAccountId: accountId });
  const right = customer(rightId, {
    sourceAccountId: accountId,
    email: "",
    phone: ""
  });
  const traces = [];
  const first = await runCustomerSync(pool, syncCommand("full-inactivate", {
    async fetchPage(input) {
      traces.push(structuredClone(input));
      return {
        records: [right, left],
        complete: true,
        snapshotComplete: true
      };
    }
  }, { accountId, subsidiaryId: null, pageSize: 0 }));
  assert.equal(first.status, "completed");
  assert.equal(first.created, 2);
  assert.equal(first.inactivated, 0);
  assert.deepEqual(traces[0], {
    cursor: null,
    limit: 500,
    syncKind: "full_reconciliation"
  });

  const second = await runCustomerSync(pool, syncCommand("full-inactivate-second", {
    async fetchPage(input) {
      traces.push(structuredClone(input));
      return {
        records: [left],
        complete: true,
        snapshotComplete: true
      };
    }
  }, {
    syncKey: `branch-sync-${SUFFIX}-full-inactivate`,
    accountId,
    subsidiaryId: null
  }));
  assert.equal(second.status, "completed");
  assert.equal(second.unchanged, 1);
  assert.equal(second.inactivated, 1);

  const state = await query(
    `SELECT incremental_cursor_modified_at, incremental_cursor_external_id,
            last_complete_full_run_id, last_incremental_run_id,
            revision::int AS revision
       FROM netsuite_customer_sync_state WHERE sync_key = $1`,
    [`branch-sync-${SUFFIX}-full-inactivate`]
  );
  assert.equal(new Date(state.rows[0].incremental_cursor_modified_at).toISOString(), MODIFIED_A);
  assert.equal(state.rows[0].incremental_cursor_external_id, String(leftId));
  assert.ok(state.rows[0].last_complete_full_run_id);
  assert.equal(state.rows[0].last_incremental_run_id, null);
  assert.equal(state.rows[0].revision, 2);

  const missing = await query(
    `SELECT
       (SELECT active FROM netsuite_customers WHERE netsuite_id = $1) AS active,
       (SELECT count(*)::int FROM return_customer_directory
         WHERE netsuite_customer_id = $1) AS return_rows,
       (SELECT array_agg(change_type ORDER BY sequence_id)
          FROM mbt_customer_master_events WHERE customer_netsuite_id = $1) AS changes`,
    [rightId]
  );
  assert.deepEqual(missing.rows[0], {
    active: false,
    return_rows: 0,
    changes: ["upsert", "inactivate"]
  });
});

test("fresh incremental sync starts with no cursor and persists a fallback record cursor", async () => {
  const id = BASE_ID + 40;
  const trace = [];
  const result = await runCustomerSync(pool, syncCommand("fresh-incremental", {
    async fetchPage(input) {
      trace.push(structuredClone(input));
      return {
        records: [customer(id, {
          sourceAccountId: `BRANCH_SYNC_ACCOUNT_${SUFFIX}_fresh-incremental`
        })],
        nextCursor: null,
        complete: true,
        snapshotComplete: false
      };
    }
  }, { syncKind: "incremental", subsidiaryId: undefined }));
  assert.equal(result.status, "completed");
  assert.equal(result.created, 1);
  assert.equal(result.inactivated, 0);
  assert.deepEqual(trace, [{ cursor: null, limit: 10, syncKind: "incremental" }]);
  const state = await query(
    `SELECT incremental_cursor_modified_at, incremental_cursor_external_id,
            last_incremental_run_id, last_complete_full_run_id
       FROM netsuite_customer_sync_state WHERE sync_key = $1`,
    [`branch-sync-${SUFFIX}-fresh-incremental`]
  );
  assert.equal(new Date(state.rows[0].incremental_cursor_modified_at).toISOString(), MODIFIED_A);
  assert.equal(state.rows[0].incremental_cursor_external_id, String(id));
  assert.ok(state.rows[0].last_incremental_run_id);
  assert.equal(state.rows[0].last_complete_full_run_id, null);
});

test("empty incremental snapshot advances its source cursor as an exact no-op", async () => {
  const cursor = { modifiedAt: MODIFIED_B, internalId: BASE_ID + 50 };
  const result = await runCustomerSync(pool, syncCommand("empty-incremental", {
    async fetchPage() {
      return {
        records: [],
        nextCursor: cursor,
        complete: true,
        snapshotComplete: false
      };
    }
  }, { syncKind: "incremental" }));
  assert.deepEqual(result, {
    status: "completed",
    pagesApplied: 1,
    recordsSeen: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    conflicted: 0,
    ignored: 0,
    outcomes: [],
    inactivated: 0
  });
  const state = await query(
    `SELECT incremental_cursor_modified_at, incremental_cursor_external_id
       FROM netsuite_customer_sync_state WHERE sync_key = $1`,
    [`branch-sync-${SUFFIX}-empty-incremental`]
  );
  assert.equal(new Date(state.rows[0].incremental_cursor_modified_at).toISOString(), MODIFIED_B);
  assert.equal(state.rows[0].incremental_cursor_external_id, String(cursor.internalId));
});

test("malformed direct apply rolls back its provisional run, receipt, and audit", async () => {
  const base = applyCommand("malformed-rollback", []);
  const command = { ...base, aggregates: { not: "an array" } };
  await assert.rejects(
    applyCanonicalCustomerAggregates(pool, command),
    (error) => error instanceof TypeError
      && error.message === "At least one canonical customer aggregate is required."
  );
  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM netsuite_customer_sync_runs
         WHERE correlation_id = $1) AS runs,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $2 AND idempotency_key = $3) AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $2 AND idempotency_key = $3) AS audits`,
    [base.correlationId, base.actorId, base.idempotencyKey]
  );
  assert.deepEqual(evidence.rows[0], { runs: 0, receipts: 0, audits: 0 });
});

test("source failure is durably recorded without canonical state or cursor", async () => {
  const command = syncCommand("source-failure", /** @type {never} */ (null));
  await assert.rejects(
    runCustomerSync(pool, command),
    (error) => error instanceof TypeError
      && error.message === "A customer source page reader is required."
  );
  const evidence = await query(
    `SELECT status, error_code, error_message
       FROM netsuite_customer_sync_runs WHERE correlation_id = $1`,
    [command.correlationId]
  );
  assert.deepEqual(evidence.rows[0], {
    status: "failed",
    error_code: "MBT_CUSTOMER_SYNC_FAILED",
    error_message: "A customer source page reader is required."
  });
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM netsuite_customer_sync_state WHERE sync_key = $1",
    [command.syncKey]
  )).rows[0].count, 0);
});

test("lease loss after source read blocks canonical writes and cursor advancement", async () => {
  const id = BASE_ID + 70;
  const command = syncCommand("real-lease-loss", {
    async fetchPage() {
      await query(
        `UPDATE netsuite_customer_sync_runs
            SET status = 'failed', error_code = 'SYNTHETIC_LEASE_REVOKED',
                error_message = 'Synthetic lease revocation', completed_at = now()
          WHERE correlation_id = $1 AND status = 'running'`,
        [`branch-sync-correlation-${SUFFIX}-real-lease-loss`]
      );
      return {
        records: [customer(id, {
          sourceAccountId: `BRANCH_SYNC_ACCOUNT_${SUFFIX}_real-lease-loss`
        })],
        nextCursor: { modifiedAt: MODIFIED_A, internalId: id },
        complete: true,
        snapshotComplete: true
      };
    }
  });
  await assert.rejects(
    runCustomerSync(pool, command),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_CUSTOMER_SYNC_LEASE_LOST"
  );
  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM netsuite_customers WHERE netsuite_id = $1) AS customers,
       (SELECT count(*)::int FROM netsuite_customer_sync_state WHERE sync_key = $2) AS states,
       (SELECT status FROM netsuite_customer_sync_runs WHERE correlation_id = $3) AS run_status`,
    [id, command.syncKey, command.correlationId]
  );
  assert.deepEqual(evidence.rows[0], {
    customers: 0,
    states: 0,
    run_status: "failed"
  });
});
