// @ts-check

/**
 * Executable branch-hardening specification:
 *
 * - cursor, source, aggregate, and sync-command validation rejects malformed
 *   values before transport or canonical writes;
 * - authoritative source precedence and deterministic reduction retain their
 *   exact public actions and reason codes;
 * - the NetSuite adapter exposes one frozen read method, normalizes requests,
 *   clones responses, and propagates transport failures without write access;
 * - bounded snapshot failures preserve their stable error codes; and
 * - failure-evidence faults never replace the original orchestration error.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  compareCustomerCursor,
  customerIsAfterCursor,
  decideCustomerObservation,
  reconcileCustomerObservations
} from "../../../src/mbt/customer-source-rules.js";
import {
  applyCanonicalCustomerAggregatesInTransaction,
  runCustomerSync
} from "../../../src/mbt/customer-sync-service.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { createReadOnlyNetSuiteCustomerSource } from "../../../src/mbt/netsuite-customer-source.js";

const ACCOUNT_ID = `branch-account-${crypto.randomUUID()}`;
const RUN_ID = crypto.randomUUID();
const MODIFIED_AT = "2026-08-04T01:02:03.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** @param {unknown} error @param {string} message */
function exactTypeError(error, message) {
  return error instanceof TypeError && error.message === message;
}

/** @param {Partial<import("../../../src/mbt/customer-source-rules.js").CustomerObservation>} [overrides] */
function observation(overrides = {}) {
  return {
    netsuiteId: 101,
    sourceKind: "netsuite_read",
    sourceModifiedAt: MODIFIED_AT,
    sourceVersion: "source-v1",
    payloadHash: HASH_A,
    ...overrides
  };
}

/** @param {Record<string, unknown>} [overrides] */
function aggregate(overrides = {}) {
  return {
    netsuiteId: 101,
    entityNumber: "CUST-101",
    legalName: "Branch Customer Legal",
    displayName: "Branch Customer",
    currency: "CAD",
    sourceModifiedAt: MODIFIED_AT,
    sourceVersion: "source-v1",
    payloadHash: HASH_A,
    ...overrides
  };
}

const NEVER_QUERY = Object.freeze({
  async query() {
    assert.fail("validation must complete before a database query");
  }
});

/** @param {unknown} aggregates @param {Record<string, unknown>} [overrides] */
async function applyInTransaction(aggregates, overrides = {}) {
  return applyCanonicalCustomerAggregatesInTransaction(NEVER_QUERY, {
    accountId: ACCOUNT_ID,
    sourceKind: "netsuite_read",
    aggregates,
    ...overrides
  }, { runId: RUN_ID });
}

/** @param {unknown} aggregates @param {string} message @param {Record<string, unknown>} [overrides] */
async function rejectsAggregate(aggregates, message, overrides) {
  await assert.rejects(
    applyInTransaction(aggregates, overrides),
    (error) => exactTypeError(error, message)
  );
}

test("customer source rules reject malformed cursor and observation identities at the boundary", () => {
  const valid = { modifiedAt: MODIFIED_AT, internalId: 10 };
  assert.throws(
    () => compareCustomerCursor({ modifiedAt: "not-a-date", internalId: 1 }, valid),
    (error) => exactTypeError(error, "Customer cursor modifiedAt must be a valid timestamp.")
  );
  assert.throws(
    () => compareCustomerCursor(valid, { modifiedAt: null, internalId: 1 }),
    (error) => exactTypeError(error, "Customer cursor modifiedAt must be a valid timestamp.")
  );
  for (const internalId of [0, -1, Number.MAX_SAFE_INTEGER + 1, "", "01", "1.5", null]) {
    assert.throws(
      () => compareCustomerCursor({ modifiedAt: MODIFIED_AT, internalId }, valid),
      (error) => exactTypeError(error, "Customer cursor internalId must be a positive integer.")
    );
  }
  assert.throws(
    () => compareCustomerCursor(
      { modifiedAt: MODIFIED_AT, internalId: "9223372036854775808" },
      valid
    ),
    (error) => exactTypeError(error, "Customer cursor internalId exceeds the PostgreSQL bigint range.")
  );
  assert.equal(compareCustomerCursor(valid, valid), 0);
  assert.equal(compareCustomerCursor({ ...valid, internalId: 9 }, valid), -1);
  assert.equal(compareCustomerCursor({ ...valid, internalId: 11 }, valid), 1);
  assert.equal(compareCustomerCursor(
    { modifiedAt: "2026-08-04T01:02:04.000Z", internalId: 1 },
    valid
  ), 1_000);
  assert.equal(customerIsAfterCursor({ ...valid, internalId: 11 }, valid), true);
  assert.equal(customerIsAfterCursor({ ...valid, internalId: 9 }, valid), false);

  for (const [candidate, message] of [
    [observation({ netsuiteId: 0 }), "Customer NetSuite ID must be a positive integer."],
    [observation({ sourceKind: "local_edit" }), "Customer source kind is not supported."],
    [observation({ sourceKind: null }), "Customer source kind is not supported."],
    [observation({ sourceModifiedAt: "invalid" }), "Customer sourceModifiedAt must be a valid timestamp."],
    [observation({ sourceVersion: " " }), "Customer sourceVersion is required."],
    [observation({ sourceVersion: null }), "Customer sourceVersion is required."],
    [observation({ payloadHash: "" }), "Customer payloadHash is required."],
    [observation({ payloadHash: null }), "Customer payloadHash is required."]
  ]) {
    assert.throws(
      () => decideCustomerObservation(null, candidate),
      (error) => exactTypeError(error, message)
    );
  }
  assert.throws(
    () => decideCustomerObservation(observation({ netsuiteId: 102 }), observation()),
    (error) => exactTypeError(
      error,
      "Customer observations must share one NetSuite internal ID."
    )
  );
});

test("customer source precedence exposes every action and stable reason without mutating inputs", () => {
  const csv = observation({ sourceKind: "csv_bootstrap" });
  const live = observation({ sourceKind: "netsuite_read", sourceModifiedAt: "2026-08-03T00:00:00.000Z" });
  const masterEvent = observation({
    sourceKind: "customer_master_event",
    sourceModifiedAt: "2026-08-05T00:00:00.000Z",
    sourceVersion: "event-v1",
    payloadHash: HASH_B
  });
  const inputs = structuredClone({ csv, live, masterEvent });

  assert.deepEqual(decideCustomerObservation(null, csv), {
    action: "apply",
    reason: "customer_not_observed"
  });
  assert.deepEqual(decideCustomerObservation(csv, live), {
    action: "apply",
    reason: "authoritative_source_supersedes_csv"
  });
  assert.deepEqual(decideCustomerObservation(live, { ...csv, payloadHash: live.payloadHash }), {
    action: "unchanged",
    reason: "csv_matches_authoritative_source"
  });
  assert.deepEqual(decideCustomerObservation(live, { ...csv, payloadHash: HASH_B }), {
    action: "conflict",
    reason: "csv_cannot_overwrite_authoritative_source"
  });
  assert.deepEqual(decideCustomerObservation(masterEvent, {
    ...masterEvent,
    sourceModifiedAt: "2026-08-04T00:00:00.000Z"
  }), { action: "ignore", reason: "older_source_observation" });
  assert.deepEqual(decideCustomerObservation(live, masterEvent), {
    action: "apply",
    reason: "newer_source_observation"
  });
  assert.deepEqual(decideCustomerObservation(masterEvent, structuredClone(masterEvent)), {
    action: "unchanged",
    reason: "exact_source_observation"
  });
  assert.deepEqual(decideCustomerObservation(masterEvent, {
    ...masterEvent,
    sourceVersion: "event-v2"
  }), { action: "unchanged", reason: "equivalent_source_payload" });
  assert.deepEqual(decideCustomerObservation(masterEvent, {
    ...masterEvent,
    payloadHash: HASH_A
  }), { action: "conflict", reason: "equal_time_different_payload" });
  assert.deepEqual({ csv, live, masterEvent }, inputs);
});

test("customer reconciliation validates collections and deterministically exercises every tie breaker", () => {
  assert.throws(
    () => reconcileCustomerObservations(/** @type {never} */ (null), []),
    (error) => exactTypeError(error, "Customer observation collections must be arrays.")
  );
  assert.throws(
    () => reconcileCustomerObservations([], /** @type {never} */ ({})),
    (error) => exactTypeError(error, "Customer observation collections must be arrays.")
  );

  const sameId = 202;
  const atBase = observation({ netsuiteId: sameId });
  const orderingCases = [
    [observation({ netsuiteId: 203 }), atBase],
    [observation({ netsuiteId: sameId, sourceModifiedAt: "2026-08-04T01:02:04.000Z" }), atBase],
    [observation({ netsuiteId: sameId, sourceKind: "customer_master_event" }), atBase],
    [observation({ netsuiteId: sameId, sourceKind: "csv_bootstrap" }), atBase],
    [observation({ netsuiteId: sameId, sourceVersion: "source-v2" }), atBase],
    [observation({ netsuiteId: sameId, payloadHash: HASH_B }), atBase]
  ];
  for (const existing of orderingCases) {
    const result = reconcileCustomerObservations(existing, []);
    assert.ok(result.customers.length >= 1);
    assert.deepEqual(result.conflicts, []);
  }

  const conflict = reconcileCustomerObservations([atBase], [{
    ...atBase,
    payloadHash: HASH_B
  }]);
  assert.equal(conflict.customers.length, 1);
  assert.deepEqual(conflict.conflicts, [{
    netsuiteId: sameId,
    current: atBase,
    incoming: { ...atBase, payloadHash: HASH_B },
    reason: "equal_time_different_payload"
  }]);
});

test("read-only NetSuite source normalizes requests, clones DTOs, and exposes no mutation transport", async () => {
  assert.throws(
    () => createReadOnlyNetSuiteCustomerSource(),
    (error) => exactTypeError(error, "A read-only customer query function is required.")
  );
  assert.throws(
    () => createReadOnlyNetSuiteCustomerSource({ queryCustomers: /** @type {never} */ ("no") }),
    (error) => exactTypeError(error, "A read-only customer query function is required.")
  );

  const requests = [];
  const transportFailure = new Error("synthetic read transport failure");
  let response = {
    records: [{ id: 1, nested: { retained: true } }],
    nextCursor: {
      modifiedAt: "2026-08-04T03:02:03-04:00",
      internalId: "9223372036854775807"
    },
    complete: "truthy",
    snapshotComplete: true
  };
  const source = createReadOnlyNetSuiteCustomerSource({
    async queryCustomers(input) {
      requests.push(structuredClone(input));
      if (input.fail === true) {
        throw transportFailure;
      }
      return response;
    }
  });
  assert.equal(Object.isFrozen(source), true);
  assert.deepEqual(Object.keys(source), ["fetchPage"]);

  const first = await source.fetchPage({ marker: "default" });
  assert.deepEqual(requests[0], { marker: "default", cursor: null, limit: 500 });
  assert.deepEqual(first, {
    records: [{ id: 1, nested: { retained: true } }],
    nextCursor: {
      modifiedAt: "2026-08-04T07:02:03.000Z",
      internalId: "9223372036854775807"
    },
    complete: false,
    snapshotComplete: true
  });
  first.records[0].nested.retained = false;
  assert.equal(response.records[0].nested.retained, true);

  response = { records: [], nextCursor: null, complete: true, snapshotComplete: false };
  const second = await source.fetchPage({
    limit: "2",
    cursor: { modifiedAt: MODIFIED_AT, internalId: 7 }
  });
  assert.deepEqual(requests[1], {
    limit: 2,
    cursor: { modifiedAt: MODIFIED_AT, internalId: 7 }
  });
  assert.deepEqual(second, {
    records: [],
    nextCursor: null,
    complete: true,
    snapshotComplete: false
  });
  await assert.rejects(source.fetchPage({ fail: true }), (error) => error === transportFailure);
});

test("read-only NetSuite source rejects malformed inputs and returned pages exactly", async () => {
  let response = { records: [], nextCursor: null, complete: true };
  const source = createReadOnlyNetSuiteCustomerSource({
    async queryCustomers() {
      return response;
    }
  });

  for (const input of [null, "page", []]) {
    await assert.rejects(
      source.fetchPage(/** @type {never} */ (input)),
      (error) => exactTypeError(error, "Customer source page input must be an object.")
    );
  }
  for (const limit of [0, -1, 1.5, 1001, "bad"]) {
    await assert.rejects(
      source.fetchPage({ limit }),
      (error) => exactTypeError(error, "Customer source page size must be between 1 and 1000.")
    );
  }
  for (const value of [0, "cursor", []]) {
    await assert.rejects(
      source.fetchPage({ cursor: value }),
      (error) => exactTypeError(error, "Customer source cursor must be an object or null.")
    );
  }
  await assert.rejects(
    source.fetchPage({ cursor: { modifiedAt: "invalid", internalId: 1 } }),
    (error) => exactTypeError(error, "Customer source cursor modifiedAt must be a valid timestamp.")
  );
  await assert.rejects(
    source.fetchPage({ cursor: { modifiedAt: null, internalId: 1 } }),
    (error) => exactTypeError(error, "Customer source cursor modifiedAt must be a valid timestamp.")
  );
  for (const internalId of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      source.fetchPage({ cursor: { modifiedAt: MODIFIED_AT, internalId } }),
      (error) => exactTypeError(error, "Customer source cursor internalId must be a positive integer.")
    );
  }
  for (const internalId of ["0", "01", "1.5", "9223372036854775808", null]) {
    await assert.rejects(
      source.fetchPage({ cursor: { modifiedAt: MODIFIED_AT, internalId } }),
      (error) => exactTypeError(error, "Customer source cursor internalId must be a positive bigint.")
    );
  }

  for (const invalidPage of [null, [], "page"]) {
    response = invalidPage;
    await assert.rejects(
      source.fetchPage(),
      (error) => error instanceof MbtError
        && error.status === 502
        && error.code === "MBT_CUSTOMER_SOURCE_INVALID"
        && error.message === "Customer source returned an invalid page."
    );
  }
  response = {};
  await assert.rejects(
    source.fetchPage(),
    (error) => error instanceof MbtError
      && error.status === 502
      && error.code === "MBT_CUSTOMER_SOURCE_INVALID"
      && error.message === "Customer source page records must be an array."
  );
  response = { records: [], nextCursor: { modifiedAt: MODIFIED_AT, internalId: 0 } };
  await assert.rejects(
    source.fetchPage(),
    (error) => exactTypeError(error, "Customer source cursor internalId must be a positive integer.")
  );
});

test("canonical aggregate validation rejects malformed identity, shape, source, and child evidence before querying", async () => {
  await rejectsAggregate(null, "At least one canonical customer aggregate is required.");
  await rejectsAggregate([], "At least one canonical customer aggregate is required.");
  await rejectsAggregate({}, "At least one canonical customer aggregate is required.");
  for (const row of [null, "customer", []]) {
    await rejectsAggregate(
      [row],
      "A canonical customer aggregate is required."
    );
  }
  await rejectsAggregate([aggregate({ currency: null })], "Customer currency is required.");
  await rejectsAggregate(
    [aggregate({ currency: "CA" })],
    "Customer currency must be a three-letter ISO code."
  );
  for (const netsuiteId of [0, -1, Number.MAX_SAFE_INTEGER + 1, "", "1.5", null]) {
    await rejectsAggregate(
      [aggregate({ netsuiteId })],
      "Customer NetSuite ID must be a positive integer."
    );
  }
  await rejectsAggregate(
    [aggregate({ netsuiteId: "9223372036854775808" })],
    "Customer NetSuite ID exceeds the PostgreSQL bigint range."
  );
  for (const [field, label] of [
    ["entityNumber", "Customer entity number"],
    ["legalName", "Customer legal name"],
    ["displayName", "Customer display name"],
    ["sourceVersion", "Customer source version"]
  ]) {
    await rejectsAggregate([aggregate({ [field]: " " })], `${label} is required.`);
  }
  await rejectsAggregate(
    [aggregate({ sourceKind: "manual" })],
    "Customer source kind is not supported."
  );
  await rejectsAggregate(
    [aggregate()],
    "Customer source kind is not supported.",
    { sourceKind: null }
  );
  await rejectsAggregate(
    [aggregate({ sourceAccountId: " " })],
    "Customer source account ID is required."
  );
  await rejectsAggregate(
    [aggregate({ sourceModifiedAt: "not-a-time" })],
    "Customer source modified time must be a valid timestamp."
  );
  await rejectsAggregate(
    [aggregate({ sourceModifiedAt: null })],
    "Customer source modified time must be a valid timestamp."
  );
  await rejectsAggregate(
    [aggregate({ payloadHash: HASH_A.toUpperCase() })],
    "Customer payload hash must be a SHA-256 hash."
  );
  await rejectsAggregate(
    [aggregate({ payloadHash: null })],
    "Customer payload hash must be a SHA-256 hash."
  );
  for (const children of ["children", [null], [[]], [1]]) {
    await rejectsAggregate(
      [aggregate({ subsidiaries: children })],
      "Customer child aggregates must be object arrays."
    );
  }
  await assert.rejects(
    applyInTransaction([
      aggregate({ netsuiteId: 9 }),
      aggregate({ netsuiteId: "9" })
    ]),
    (error) => error instanceof MbtError
      && error.status === 400
      && error.code === "MBT_CUSTOMER_SOURCE_INVALID"
      && error.message === "A customer batch cannot contain duplicate NetSuite internal IDs."
  );
});

test("a conflicting observation requires a durable run before conflict evidence can be written", async () => {
  const queries = [];
  const database = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("FROM netsuite_customers c")) {
        return {
          rows: [{
            netsuite_id: "101",
            source_kind: "netsuite_read",
            source_modified_at: MODIFIED_AT,
            source_version: "source-v1",
            payload_hash: HASH_A
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  await assert.rejects(
    applyCanonicalCustomerAggregatesInTransaction(database, {
      accountId: ACCOUNT_ID,
      sourceKind: "netsuite_read",
      aggregates: [aggregate({ payloadHash: HASH_B })]
    }, { runId: "" }),
    (error) => exactTypeError(
      error,
      "A customer conflict requires a durable sync/apply run."
    )
  );
  assert.equal(queries.length, 2);
  assert.equal(queries.some((sql) => sql.includes("INSERT INTO netsuite_customer_sync_conflicts")), false);
});

/** @param {Record<string, unknown>} [overrides] */
function syncInput(overrides = {}) {
  return {
    syncKey: `branch-sync-${crypto.randomUUID()}`,
    accountId: ACCOUNT_ID,
    subsidiaryId: 33,
    syncKind: "full_reconciliation",
    sourceKind: "netsuite_read",
    correlationId: `branch-correlation-${crypto.randomUUID()}`,
    requestedBy: "branch-admin",
    pageSize: 25,
    source: {
      async fetchPage() {
        return {
          records: [aggregate()],
          nextCursor: { modifiedAt: MODIFIED_AT, internalId: 101 },
          complete: true,
          snapshotComplete: true
        };
      }
    },
    ...overrides
  };
}

/**
 * @param {{claimError?: unknown, failError?: unknown, leaseStatus?: string}} [options]
 */
function evidenceBoundary(options = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params: structuredClone(params) });
      if (sql.includes("INSERT INTO netsuite_customer_sync_runs")) {
        if (options.claimError) {
          throw options.claimError;
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("netsuite_customer_sync_state")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT status FROM netsuite_customer_sync_runs")) {
        return { rows: [{ status: options.leaseStatus || "completed" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE netsuite_customer_sync_runs")) {
        if (options.failError) {
          throw options.failError;
        }
        return { rows: [], rowCount: 1 };
      }
      assert.fail(`unexpected customer sync query: ${sql}`);
    }
  };
}

test("customer sync command validation fails before claiming a lease", async () => {
  for (const [patch, message] of [
    [{ syncKey: null }, "Customer sync key is required."],
    [{ accountId: " " }, "Customer sync account ID is required."],
    [{ subsidiaryId: 0 }, "Customer sync subsidiary ID must be a positive integer."],
    [{ subsidiaryId: "9223372036854775808" }, "Customer sync subsidiary ID exceeds the PostgreSQL bigint range."],
    [{ syncKind: "manual" }, "Customer sync kind is not supported."],
    [{ sourceKind: "manual" }, "Customer source kind is not supported."],
    [{ correlationId: "" }, "Customer sync correlation ID is required."],
    [{ requestedBy: null }, "Customer sync requester is required."]
  ]) {
    await assert.rejects(
      runCustomerSync(NEVER_QUERY, syncInput(patch)),
      (error) => exactTypeError(error, message)
    );
  }
});

test("customer sync preserves claim and failure-evidence errors at their observable boundaries", async () => {
  const claimFailure = Object.assign(new Error("claim transport failed"), { code: "08006" });
  await assert.rejects(
    runCustomerSync(evidenceBoundary({ claimError: claimFailure }), syncInput()),
    (error) => error === claimFailure
  );

  const evidenceFailure = new Error("failure evidence unavailable");
  const evidence = evidenceBoundary({ failError: evidenceFailure });
  await assert.rejects(
    runCustomerSync(evidence, syncInput({ source: null })),
    (error) => exactTypeError(error, "A customer source page reader is required.")
  );
  assert.equal(
    evidence.calls.some(({ sql }) => sql.includes("UPDATE netsuite_customer_sync_runs")),
    true
  );

  const nullFailureEvidence = evidenceBoundary();
  let caught = Symbol("not-caught");
  try {
    await runCustomerSync(nullFailureEvidence, syncInput({
      source: { async fetchPage() { throw null; } }
    }));
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, null);
  const failedUpdate = nullFailureEvidence.calls.find(({ sql }) => (
    sql.includes("UPDATE netsuite_customer_sync_runs")
  ));
  assert.equal(failedUpdate.params[1], "MBT_CUSTOMER_SYNC_FAILED");
  assert.equal(failedUpdate.params[2], "null");
});

test("customer sync rejects malformed pages, cursor stalls, cursor absence, and the hard page bound", async () => {
  const failureCases = [
    [null, "MBT_CUSTOMER_SOURCE_INVALID"],
    [[], "MBT_CUSTOMER_SOURCE_INVALID"],
    [{}, "MBT_CUSTOMER_SOURCE_INVALID"],
    [{ records: [], complete: false }, "MBT_CUSTOMER_SNAPSHOT_INCOMPLETE"],
    [{ records: [], nextCursor: "cursor", complete: false }, "MBT_CUSTOMER_SNAPSHOT_INCOMPLETE"],
    [{ records: [], nextCursor: [], complete: false }, "MBT_CUSTOMER_SNAPSHOT_INCOMPLETE"],
    [{
      records: [],
      nextCursor: { modifiedAt: "invalid", internalId: 1 },
      complete: false
    }, "TYPE_ERROR"],
    [{
      records: [],
      nextCursor: { modifiedAt: MODIFIED_AT, internalId: 0 },
      complete: false
    }, "TYPE_ERROR"]
  ];
  for (const [page, code] of failureCases) {
    const database = evidenceBoundary();
    await assert.rejects(
      runCustomerSync(database, syncInput({
        source: { async fetchPage() { return page; } }
      })),
      (error) => code === "TYPE_ERROR"
        ? error instanceof TypeError
        : error instanceof MbtError && error.code === code
    );
  }

  const noCursorDatabase = evidenceBoundary();
  await assert.rejects(
    runCustomerSync(noCursorDatabase, syncInput({
      syncKind: "incremental",
      source: {
        async fetchPage() {
          return { records: [], complete: true, snapshotComplete: false };
        }
      }
    })),
    (error) => error instanceof MbtError
      && error.code === "MBT_CUSTOMER_SOURCE_INVALID"
      && error.message === "Customer source did not provide a cursor."
  );

  let pages = 0;
  const boundedDatabase = evidenceBoundary();
  await assert.rejects(
    runCustomerSync(boundedDatabase, syncInput({
      source: {
        async fetchPage() {
          pages += 1;
          return {
            records: [],
            nextCursor: { modifiedAt: MODIFIED_AT, internalId: pages },
            complete: false
          };
        }
      }
    })),
    (error) => error instanceof MbtError
      && error.code === "MBT_CUSTOMER_SOURCE_INVALID"
      && error.message === "Customer source exceeded its page bound."
  );
  assert.equal(pages, 10_000);
});

test("customer sync reports an actually lost lease without entering canonical writes", async () => {
  const database = evidenceBoundary({ leaseStatus: "completed" });
  await assert.rejects(
    runCustomerSync(database, syncInput()),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_CUSTOMER_SYNC_LEASE_LOST"
  );
  assert.equal(
    database.calls.some(({ sql }) => sql.includes("INSERT INTO netsuite_customers")),
    false
  );
});
