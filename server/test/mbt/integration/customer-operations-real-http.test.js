// @ts-check

/**
 * Executable coverage-repair specification:
 *
 * - real customer operations are reached through the router's lazy service
 *   resolver, never a mocked service;
 * - Admin-only sync/run/conflict routes and Admin/Front-Desk search retain
 *   their live-role boundaries and no-store responses;
 * - run, conflict, and customer DTOs preserve nulls, timestamps, sorting, and
 *   opaque cursor pagination without duplicates;
 * - malformed search/status/limit/cursor input fails with the stable public
 *   error code before any mutation;
 * - conflict resolution is atomic, audited, exactly idempotent, stale-safe,
 *   and rejects changed-payload replay, missing rows, and resolved rows; and
 * - the unavailable live NetSuite source returns 503 without a command
 *   receipt, audit event, or external work.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import test, { after, before, beforeEach } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  getCustomerSyncRun,
  listCustomerConflicts
} from "../../../src/mbt/customer-operations-service.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { createMbtRouter } from "../../../src/mbt/router.js";

const SUFFIX = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const ACTORS = Object.freeze({
  admin: Object.freeze({
    id: `customer-real-admin-${SUFFIX}`,
    role: "admin",
    roles: ["admin"],
    homeRoute: "/admin"
  }),
  frontdesk: Object.freeze({
    id: `customer-real-frontdesk-${SUFFIX}`,
    role: "mbt_frontdesk",
    roles: ["mbt_frontdesk"],
    homeRoute: "/mbt/frontdesk"
  }),
  operator: Object.freeze({
    id: `customer-real-operator-${SUFFIX}`,
    role: "operator",
    roles: ["operator"],
    homeRoute: "/operator"
  })
});
const RUNS = Object.freeze({
  newest: crypto.randomUUID(),
  middle: crypto.randomUUID(),
  oldest: crypto.randomUUID()
});
const CONFLICTS = Object.freeze({
  nullable: crypto.randomUUID(),
  keep: crypto.randomUUID(),
  incoming: crypto.randomUUID(),
  ignore: crypto.randomUUID(),
  resolved: crypto.randomUUID()
});
const CUSTOMER_BASE = 9_100_000_000 + crypto.randomInt(100_000);
const CUSTOMERS = Object.freeze({
  alpha: CUSTOMER_BASE,
  beta: CUSTOMER_BASE + 1,
  inactive: CUSTOMER_BASE + 2
});
const SEARCH_TOKEN = `Cov${SUFFIX}`;
const HASHES = Object.freeze({
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64)
});
const ALL_CONFLICT_IDS = Object.freeze(Object.values(CONFLICTS));

let baseUrl = "";
let server;
let capabilityAllowed = true;

function authenticate(req, res, next) {
  const actor = ACTORS[String(req.get("authorization") || "").replace(/^Bearer\s+/iu, "")];
  if (!actor) {
    res.setHeader("cache-control", "no-store");
    return res.status(401).json({ error: "Login required" });
  }
  req.operator = actor;
  return next();
}

async function authorizePhase3Capability({ capability }) {
  assert.equal(capability, "customerSync");
  if (!capabilityAllowed) {
    throw new MbtError({
      status: 409,
      code: "MBT_CAPABILITY_DISABLED",
      message: "Customer sync is disabled."
    });
  }
}

/**
 * @param {string} path
 * @param {{actor?: keyof typeof ACTORS, method?: string, body?: unknown, key?: string, correlationId?: string, requestId?: string}} [options]
 */
async function request(path, {
  actor,
  method = "GET",
  body,
  key,
  correlationId = `customer-real-correlation-${SUFFIX}`,
  requestId = `customer-real-request-${crypto.randomUUID()}`
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(actor ? { authorization: `Bearer ${actor}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
      "x-correlation-id": correlationId,
      "x-request-id": requestId
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return {
    response,
    payload: await response.json().catch(() => ({}))
  };
}

async function seedRuns() {
  await query(
    `INSERT INTO netsuite_customer_sync_runs (
       run_id, sync_kind, status, account_id, subsidiary_id, requested_by,
       correlation_id, pages_expected, pages_applied, records_seen,
       records_applied, records_conflicted, error_code, error_message,
       requested_at, started_at, completed_at
     ) VALUES
       ($1, 'full_reconciliation', 'completed', $4, 33, $5, $6,
        2, 2, 7, 6, 1, NULL, NULL,
        '2999-03-03T03:03:03.000Z', '2999-03-03T03:04:03.000Z', '2999-03-03T03:05:03.000Z'),
       ($2, 'incremental', 'failed', $4, NULL, NULL, $7,
        NULL, 1, 4, 2, 2, 'SOURCE_TIMEOUT', 'Synthetic timeout',
        '2999-02-02T02:02:02.000Z', '2999-02-02T02:03:02.000Z', NULL),
       ($3, 'incremental', 'pending', $4, NULL, NULL, $8,
        NULL, 0, 0, 0, 0, NULL, NULL,
        '2999-01-01T01:01:01.000Z', NULL, NULL)`,
    [
      RUNS.newest,
      RUNS.middle,
      RUNS.oldest,
      `customer-real-account-${SUFFIX}`,
      ACTORS.admin.id,
      `run-newest-correlation-${SUFFIX}`,
      `run-middle-correlation-${SUFFIX}`,
      `run-oldest-correlation-${SUFFIX}`
    ]
  );
}

async function seedCustomers() {
  await query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, currency,
       terms, tax_status, credit_status, email, phone, active,
       source_modified_at, source_version, payload_hash, last_seen_run_id
     ) VALUES
       ($1, $4, $5, $6, 'CAD', 'Net 30', 'taxable', 'good',
        $7, $8, true, '2998-01-01T00:00:00.000Z', $9, $10, $13),
       ($2, $11, $12, $14, 'USD', NULL, NULL, NULL,
        NULL, NULL, true, '2998-02-02T00:00:00.000Z', $15, $16, $13),
       ($3, $17, $18, $19, 'CAD', NULL, NULL, NULL,
        '', '', false, '2998-03-03T00:00:00.000Z', $20, $21, $13)`,
    [
      CUSTOMERS.alpha,
      CUSTOMERS.beta,
      CUSTOMERS.inactive,
      `${SEARCH_TOKEN}-001`,
      `${SEARCH_TOKEN} Alpha Legal`,
      `${SEARCH_TOKEN} Alpha`,
      `alpha-${SUFFIX}@example.invalid`,
      "416-555-0101",
      `version-alpha-${SUFFIX}`,
      HASHES.a,
      `${SEARCH_TOKEN}-002`,
      `${SEARCH_TOKEN} Beta Legal`,
      RUNS.newest,
      `${SEARCH_TOKEN} beta`,
      `version-beta-${SUFFIX}`,
      HASHES.b,
      `${SEARCH_TOKEN}-003`,
      `${SEARCH_TOKEN} Inactive Legal`,
      `${SEARCH_TOKEN} Inactive`,
      `version-inactive-${SUFFIX}`,
      HASHES.c
    ]
  );
}

/** @param {{id: string, externalId: string, createdAt: string, status?: string}} input */
async function seedConflict({ id, externalId, createdAt, status = "open" }) {
  const resolved = status !== "open";
  await query(
    `INSERT INTO netsuite_customer_sync_conflicts (
       conflict_id, run_id, entity_type, customer_netsuite_id, external_id,
       current_source_modified_at, incoming_source_modified_at,
       current_payload_hash, incoming_payload_hash,
       current_snapshot, incoming_snapshot, status, resolution_note,
       resolved_by, resolved_at, revision, created_at, updated_at
     ) VALUES (
       $1, $2, 'customer', $3, $4,
       $5::timestamptz, '2999-04-04T00:00:00.000Z',
       $6, $7, $8::jsonb, $9::jsonb, $10,
       $11, $12, $13::timestamptz, $14, $15::timestamptz, $15::timestamptz
     )`,
    [
      id,
      RUNS.newest,
      externalId.endsWith("nullable") ? null : CUSTOMERS.alpha,
      externalId,
      externalId.endsWith("nullable") ? null : "2998-01-01T00:00:00.000Z",
      externalId.endsWith("nullable") ? null : HASHES.a,
      HASHES.b,
      externalId.endsWith("nullable") ? null : JSON.stringify({ displayName: "Current" }),
      JSON.stringify({ displayName: "Incoming", externalId }),
      status,
      resolved ? "Previously reviewed" : null,
      resolved ? ACTORS.admin.id : null,
      resolved ? "2999-05-05T00:00:00.000Z" : null,
      resolved ? 2 : 1,
      createdAt
    ]
  );
}

async function seedConflicts() {
  await seedConflict({
    id: CONFLICTS.nullable,
    externalId: `${SEARCH_TOKEN}-nullable`,
    createdAt: "1900-01-01T00:00:00.000Z"
  });
  await seedConflict({
    id: CONFLICTS.keep,
    externalId: `${SEARCH_TOKEN}-keep`,
    createdAt: "1900-01-02T00:00:00.000Z"
  });
  await seedConflict({
    id: CONFLICTS.incoming,
    externalId: `${SEARCH_TOKEN}-incoming`,
    createdAt: "1900-01-03T00:00:00.000Z"
  });
  await seedConflict({
    id: CONFLICTS.ignore,
    externalId: `${SEARCH_TOKEN}-ignore`,
    createdAt: "1900-01-04T00:00:00.000Z"
  });
  await seedConflict({
    id: CONFLICTS.resolved,
    externalId: `${SEARCH_TOKEN}-resolved`,
    createdAt: "1900-01-05T00:00:00.000Z",
    status: "ignored"
  });
}

async function cleanup() {
  // Command receipts and audit events are intentionally append-only. Unique
  // actor/idempotency identifiers keep this fixture isolated without weakening
  // those production invariants for teardown.
  await query(
    "DELETE FROM netsuite_customer_sync_conflicts WHERE conflict_id = ANY($1::uuid[])",
    [ALL_CONFLICT_IDS]
  );
  await query(
    `UPDATE netsuite_customers
        SET active = false, last_seen_run_id = NULL
      WHERE netsuite_id = ANY($1::bigint[])`,
    [[CUSTOMERS.alpha, CUSTOMERS.beta, CUSTOMERS.inactive]]
  );
  await query(
    "DELETE FROM netsuite_customer_sync_runs WHERE run_id = ANY($1::uuid[])",
    [Object.values(RUNS)]
  );
}

before(async () => {
  await seedRuns();
  await seedCustomers();
  await seedConflicts();
  const app = express();
  app.use(express.json());
  app.use(authenticate);
  app.use("/api/mbt", createMbtRouter({ authorizePhase3Capability }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  capabilityAllowed = true;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  await cleanup().catch(() => null);
  await closeDb();
});

test("P3 customer operations real router: sync run DTOs paginate newest-first and reject malformed list input", async () => {
  const unauthenticated = await request("/api/mbt/customers/sync/runs");
  assert.equal(unauthenticated.response.status, 401);
  assert.deepEqual(unauthenticated.payload, { error: "Login required" });
  assert.match(unauthenticated.response.headers.get("cache-control") || "", /no-store/u);
  assert.equal((await request("/api/mbt/customers/sync/runs", { actor: "operator" })).response.status, 403);

  const first = await request("/api/mbt/customers/sync/runs?limit=2", { actor: "admin" });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.match(first.response.headers.get("cache-control") || "", /no-store/u);
  assert.deepEqual(first.payload.items.map(({ runId }) => runId), [RUNS.newest, RUNS.middle]);
  assert.equal(typeof first.payload.nextCursor, "string");
  assert.deepEqual(first.payload.items[0], {
    runId: RUNS.newest,
    syncKind: "full_reconciliation",
    status: "completed",
    accountId: `customer-real-account-${SUFFIX}`,
    subsidiaryId: "33",
    requestedBy: ACTORS.admin.id,
    pagesExpected: 2,
    pagesApplied: 2,
    recordsSeen: 7,
    recordsApplied: 6,
    recordsConflicted: 1,
    errorCode: null,
    errorMessage: null,
    requestedAt: "2999-03-03T03:03:03.000Z",
    startedAt: "2999-03-03T03:04:03.000Z",
    completedAt: "2999-03-03T03:05:03.000Z"
  });
  assert.equal(first.payload.items[1].subsidiaryId, null);
  assert.equal(first.payload.items[1].requestedBy, null);
  assert.equal(first.payload.items[1].pagesExpected, null);
  assert.equal(first.payload.items[1].errorCode, "SOURCE_TIMEOUT");
  assert.equal(first.payload.items[1].completedAt, null);

  const second = await request(
    `/api/mbt/customers/sync/runs?limit=1&cursor=${encodeURIComponent(first.payload.nextCursor)}`,
    { actor: "admin" }
  );
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  assert.deepEqual(second.payload.items.map(({ runId }) => runId), [RUNS.oldest]);

  for (const [path, code] of [
    ["/api/mbt/customers/sync/runs?limit=0", "MBT_CUSTOMER_LIMIT_INVALID"],
    ["/api/mbt/customers/sync/runs?limit=101", "MBT_CUSTOMER_LIMIT_INVALID"],
    ["/api/mbt/customers/sync/runs?cursor=not-base64-json", "MBT_CUSTOMER_CURSOR_INVALID"]
  ]) {
    const invalid = await request(path, { actor: "admin" });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.code, code);
  }
});

test("P3 customer operations real router: run detail preserves nullable DTO fields and distinguishes blank and missing IDs", async () => {
  const detail = await request(`/api/mbt/customers/sync/runs/${RUNS.oldest}`, { actor: "admin" });
  assert.equal(detail.response.status, 200, JSON.stringify(detail.payload));
  assert.equal(detail.payload.schemaVersion, "mbt-customer-sync-run-v1");
  assert.equal(detail.payload.runId, RUNS.oldest);
  assert.equal(detail.payload.startedAt, null);
  assert.equal(detail.payload.completedAt, null);

  const missing = await request(`/api/mbt/customers/sync/runs/${crypto.randomUUID()}`, { actor: "admin" });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload.code, "MBT_CUSTOMER_SYNC_RUN_NOT_FOUND");

  await assert.rejects(
    () => getCustomerSyncRun("   "),
    (error) => error instanceof MbtError
      && error.status === 400
      && error.code === "MBT_CUSTOMER_INPUT_INVALID"
  );
  await assert.rejects(
    () => getCustomerSyncRun(/** @type {never} */ (null)),
    (error) => error instanceof MbtError
      && error.status === 400
      && error.code === "MBT_CUSTOMER_INPUT_INVALID"
  );
});

test("P3 customer operations real router: conflict filters and cursors preserve complete nullable and resolved evidence", async () => {
  const defaultStatus = await listCustomerConflicts({ status: "", limit: 1 });
  assert.deepEqual(defaultStatus.items.map(({ conflictId }) => conflictId), [CONFLICTS.nullable]);

  const first = await request("/api/mbt/customers/conflicts?limit=1", { actor: "admin" });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.deepEqual(first.payload.items.map(({ conflictId }) => conflictId), [CONFLICTS.nullable]);
  assert.equal(first.payload.items[0].currentSourceModifiedAt, null);
  assert.equal(first.payload.items[0].customerNetSuiteId, null);
  assert.equal(first.payload.items[0].currentSnapshot, null);
  assert.equal(first.payload.items[0].resolvedAt, null);
  assert.equal(typeof first.payload.nextCursor, "string");

  const second = await request(
    `/api/mbt/customers/conflicts?status=open&limit=1&cursor=${encodeURIComponent(first.payload.nextCursor)}`,
    { actor: "admin" }
  );
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  assert.deepEqual(second.payload.items.map(({ conflictId }) => conflictId), [CONFLICTS.keep]);

  const all = await request("/api/mbt/customers/conflicts?status=all&limit=100", { actor: "admin" });
  assert.equal(all.response.status, 200, JSON.stringify(all.payload));
  const resolved = all.payload.items.find(({ conflictId }) => conflictId === CONFLICTS.resolved);
  assert.equal(resolved.status, "ignored");
  assert.equal(resolved.resolutionNote, "Previously reviewed");
  assert.equal(resolved.resolvedBy, ACTORS.admin.id);
  assert.equal(resolved.resolvedAt, "2999-05-05T00:00:00.000Z");
  assert.equal(resolved.revision, 2);

  for (const [path, code] of [
    ["/api/mbt/customers/conflicts?status=unknown", "MBT_CUSTOMER_CONFLICT_STATUS_INVALID"],
    ["/api/mbt/customers/conflicts?limit=-1", "MBT_CUSTOMER_LIMIT_INVALID"],
    ["/api/mbt/customers/conflicts?cursor=W10", "MBT_CUSTOMER_CURSOR_INVALID"]
  ]) {
    const invalid = await request(path, { actor: "admin" });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.code, code);
  }
});

test("P3 customer operations real router: active customer search is role-bound, stable, paginated, and validates input", async () => {
  const forbidden = await request(`/api/mbt/customers/search?query=${SEARCH_TOKEN}`, { actor: "operator" });
  assert.equal(forbidden.response.status, 403);

  const first = await request(
    `/api/mbt/customers/search?query=${SEARCH_TOKEN}&limit=1`,
    { actor: "frontdesk" }
  );
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.match(first.response.headers.get("cache-control") || "", /no-store/u);
  assert.equal(first.payload.schemaVersion, "mbt-customers-v1");
  assert.equal(first.payload.items.length, 1);
  assert.deepEqual(first.payload.items[0], {
    customerNetSuiteId: String(CUSTOMERS.alpha),
    entityNumber: `${SEARCH_TOKEN}-001`,
    legalName: `${SEARCH_TOKEN} Alpha Legal`,
    displayName: `${SEARCH_TOKEN} Alpha`,
    currency: "CAD",
    terms: "Net 30",
    taxStatus: "taxable",
    creditStatus: "good",
    email: `alpha-${SUFFIX}@example.invalid`,
    phone: "416-555-0101",
    sourceModifiedAt: "2998-01-01T00:00:00.000Z"
  });
  assert.equal(typeof first.payload.nextCursor, "string");

  const second = await request(
    `/api/mbt/customers/search?query=${SEARCH_TOKEN}&limit=1&cursor=${encodeURIComponent(first.payload.nextCursor)}`,
    { actor: "admin" }
  );
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  assert.equal(second.payload.items.length, 1);
  assert.equal(second.payload.items[0].customerNetSuiteId, String(CUSTOMERS.beta));
  assert.equal(second.payload.items[0].terms, null);
  assert.equal(second.payload.items[0].email, "");
  assert.equal(second.payload.nextCursor, null, "the matching inactive customer must not leak into pagination");

  for (const [path, code] of [
    ["/api/mbt/customers/search", "MBT_CUSTOMER_SEARCH_INVALID"],
    ["/api/mbt/customers/search?query=x", "MBT_CUSTOMER_SEARCH_INVALID"],
    [`/api/mbt/customers/search?query=${SEARCH_TOKEN}&limit=bad`, "MBT_CUSTOMER_LIMIT_INVALID"],
    [`/api/mbt/customers/search?query=${SEARCH_TOKEN}&cursor=eyJub3QiOiJhbiBhcnJheSJ9`, "MBT_CUSTOMER_CURSOR_INVALID"]
  ]) {
    const invalid = await request(path, { actor: "frontdesk" });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.code, code);
  }
});

test("P3 customer operations real router: unavailable sync is gated and creates no receipt or audit", async () => {
  const unauthorized = await request("/api/mbt/customers/sync", {
    actor: "frontdesk",
    method: "POST",
    key: `customer-real-sync-unauthorized-${SUFFIX}`,
    body: { syncKind: "incremental", reason: "Unauthorized synthetic sync" }
  });
  assert.equal(unauthorized.response.status, 403);

  const noKey = await request("/api/mbt/customers/sync", {
    actor: "admin",
    method: "POST",
    body: { syncKind: "incremental", reason: "Missing key" }
  });
  assert.equal(noKey.response.status, 400);
  assert.equal(noKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");

  const noKind = await request("/api/mbt/customers/sync", {
    actor: "admin",
    method: "POST",
    key: `customer-real-sync-no-kind-${SUFFIX}`,
    body: { reason: "Missing kind" }
  });
  assert.equal(noKind.response.status, 400);
  assert.equal(noKind.payload.code, "MBT_CUSTOMER_SYNC_KIND_REQUIRED");

  const noReason = await request("/api/mbt/customers/sync", {
    actor: "admin",
    method: "POST",
    key: `customer-real-sync-no-reason-${SUFFIX}`,
    body: { syncKind: "incremental" }
  });
  assert.equal(noReason.response.status, 400);
  assert.equal(noReason.payload.code, "MBT_AUDIT_REASON_REQUIRED");

  capabilityAllowed = false;
  const gated = await request("/api/mbt/customers/sync", {
    actor: "admin",
    method: "POST",
    key: `customer-real-sync-gated-${SUFFIX}`,
    body: { syncKind: "incremental", reason: "Closed capability" }
  });
  assert.equal(gated.response.status, 409);
  assert.equal(gated.payload.code, "MBT_CAPABILITY_DISABLED");

  capabilityAllowed = true;
  const unavailable = await request("/api/mbt/customers/sync", {
    actor: "admin",
    method: "POST",
    key: `customer-real-sync-${SUFFIX}`,
    body: { syncKind: "incremental", reason: "Synthetic unavailable source" }
  });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.payload.code, "MBT_CUSTOMER_SOURCE_NOT_CONFIGURED");
  assert.match(unavailable.response.headers.get("cache-control") || "", /no-store/u);

  const durable = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_command_receipts WHERE actor_operator_id = $1) AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events WHERE actor_operator_id = $1) AS audits`,
    [ACTORS.admin.id]
  );
  assert.deepEqual(durable.rows[0], { receipts: 0, audits: 0 });
});

/**
 * @param {string} conflictId
 * @param {string} decision
 * @param {number} expectedRevision
 * @param {string} key
 * @param {string} reason
 */
async function resolveConflict(conflictId, decision, expectedRevision, key, reason) {
  return request(`/api/mbt/customers/conflicts/${conflictId}/resolve`, {
    actor: "admin",
    method: "POST",
    key,
    correlationId: `customer-real-resolve-correlation-${SUFFIX}`,
    requestId: `customer-real-resolve-request-${key}`,
    body: { decision, expectedRevision, reason }
  });
}

test("P3 customer operations real router: conflict resolution is atomic, audited, replay-safe, and stale-safe", async () => {
  const forbidden = await request(`/api/mbt/customers/conflicts/${CONFLICTS.keep}/resolve`, {
    actor: "frontdesk",
    method: "POST",
    key: `customer-real-forbidden-${SUFFIX}`,
    body: { decision: "keep_current", expectedRevision: 1, reason: "Forbidden" }
  });
  assert.equal(forbidden.response.status, 403);

  const stale = await resolveConflict(
    CONFLICTS.nullable,
    "accept_incoming",
    2,
    `customer-real-stale-${SUFFIX}`,
    "Reject stale customer conflict"
  );
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.code, "MBT_STALE_REVISION");

  const missing = await resolveConflict(
    crypto.randomUUID(),
    "ignore",
    1,
    `customer-real-missing-${SUFFIX}`,
    "Reject missing customer conflict"
  );
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload.code, "MBT_CUSTOMER_CONFLICT_NOT_FOUND");

  const already = await resolveConflict(
    CONFLICTS.resolved,
    "keep_current",
    2,
    `customer-real-resolved-${SUFFIX}`,
    "Reject already resolved conflict"
  );
  assert.equal(already.response.status, 409);
  assert.equal(already.payload.code, "MBT_CUSTOMER_CONFLICT_RESOLVED");

  const invalid = await resolveConflict(
    CONFLICTS.keep,
    "unknown",
    0,
    `customer-real-invalid-${SUFFIX}`,
    "Reject invalid decision"
  );
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.code, "MBT_CUSTOMER_CONFLICT_INPUT_INVALID");

  const missingDecision = await resolveConflict(
    CONFLICTS.keep,
    "",
    1,
    `customer-real-no-decision-${SUFFIX}`,
    "Reject missing decision"
  );
  assert.equal(missingDecision.response.status, 400);
  assert.equal(missingDecision.payload.code, "MBT_CUSTOMER_CONFLICT_INPUT_INVALID");

  const invalidRevision = await resolveConflict(
    CONFLICTS.keep,
    "keep_current",
    0,
    `customer-real-bad-revision-${SUFFIX}`,
    "Reject invalid revision"
  );
  assert.equal(invalidRevision.response.status, 400);
  assert.equal(invalidRevision.payload.code, "MBT_CUSTOMER_CONFLICT_INPUT_INVALID");

  const noReason = await request(`/api/mbt/customers/conflicts/${CONFLICTS.keep}/resolve`, {
    actor: "admin",
    method: "POST",
    key: `customer-real-no-reason-${SUFFIX}`,
    body: { decision: "keep_current", expectedRevision: 1 }
  });
  assert.equal(noReason.response.status, 400);
  assert.equal(noReason.payload.code, "MBT_AUDIT_REASON_REQUIRED");

  const noKey = await request(`/api/mbt/customers/conflicts/${CONFLICTS.keep}/resolve`, {
    actor: "admin",
    method: "POST",
    body: { decision: "keep_current", expectedRevision: 1, reason: "Missing key" }
  });
  assert.equal(noKey.response.status, 400);
  assert.equal(noKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");

  const key = `customer-real-keep-${SUFFIX}`;
  const reason = "Keep the reviewed canonical customer";
  const first = await resolveConflict(CONFLICTS.keep, "keep_current", 1, key, reason);
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.equal(first.payload.conflict.status, "resolved_current");
  assert.equal(first.payload.conflict.resolutionNote, reason);
  assert.equal(first.payload.conflict.resolvedBy, ACTORS.admin.id);
  assert.equal(first.payload.conflict.revision, 2);

  const replay = await resolveConflict(CONFLICTS.keep, "keep_current", 1, key, reason);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.response.headers.get("x-mbt-idempotent-replay"), "true");
  assert.deepEqual(replay.payload, first.payload);

  const changed = await resolveConflict(
    CONFLICTS.keep,
    "accept_incoming",
    1,
    key,
    "Changed payload must conflict"
  );
  assert.equal(changed.response.status, 409);
  assert.equal(changed.payload.code, "MBT_IDEMPOTENCY_CONFLICT");

  const incoming = await resolveConflict(
    CONFLICTS.incoming,
    "accept_incoming",
    1,
    `customer-real-incoming-${SUFFIX}`,
    "Accept the newer customer snapshot"
  );
  assert.equal(incoming.response.status, 200, JSON.stringify(incoming.payload));
  assert.equal(incoming.payload.conflict.status, "resolved_incoming");

  const ignored = await resolveConflict(
    CONFLICTS.ignore,
    "ignore",
    1,
    `customer-real-ignore-${SUFFIX}`,
    "Close as reviewed evidence"
  );
  assert.equal(ignored.response.status, 200, JSON.stringify(ignored.payload));
  assert.equal(ignored.payload.conflict.status, "ignored");

  const durable = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1 AND command_name = 'mbt.customer.conflict.resolve') AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND action = 'mbt.customer.conflict.resolved') AS audits,
       (SELECT revision::int FROM netsuite_customer_sync_conflicts WHERE conflict_id = $2) AS keep_revision,
       (SELECT status FROM netsuite_customer_sync_conflicts WHERE conflict_id = $3) AS stale_status`,
    [ACTORS.admin.id, CONFLICTS.keep, CONFLICTS.nullable]
  );
  assert.deepEqual(durable.rows[0], {
    receipts: 3,
    audits: 3,
    keep_revision: 2,
    stale_status: "open"
  });
});
