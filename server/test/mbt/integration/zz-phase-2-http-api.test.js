import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import express from "express";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { createMbtRouter } from "../../../src/mbt/router.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const RUNTIME = Object.freeze({
  accountId: "P2_SB1",
  runtimeAccountId: "P2_SB1",
  environmentName: "sandbox",
  restBaseUrl: "https://p2-sb1.suitetalk.api.netsuite.com/services/rest",
  sandboxAccountAllowlist: ["P2_SB1"],
  directAccessEnabled: true,
  readTimeoutMs: 10_000,
  preflightLeaseSeconds: 120
});
const ACTORS = Object.freeze({
  admin: {
    id: `p2-http-admin-${RUN_ID}`,
    role: "admin",
    roles: ["admin"],
    homeRoute: "/admin"
  },
  dispatcher: {
    id: `p2-http-dispatcher-${RUN_ID}`,
    role: "dispatcher",
    roles: ["dispatcher"],
    homeRoute: "/dispatch"
  }
});
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_CASES = Object.freeze([
  { method: "GET", path: "/api/mbt/config/netsuite/mappings" },
  { method: "PUT", path: "/api/mbt/config/netsuite/mappings", body: {} },
  { method: "POST", path: "/api/mbt/config/netsuite/preflight", body: {} },
  { method: "GET", path: "/api/mbt/config/netsuite/preflight/latest" },
  { method: "GET", path: `/api/mbt/config/netsuite/preflight/${crypto.randomUUID()}` },
  { method: "GET", path: `/api/mbt/config/netsuite/preflight/${crypto.randomUUID()}/export?format=json` },
  { method: "POST", path: `/api/mbt/config/netsuite/preflight/${crypto.randomUUID()}/signoff`, body: {} }
]);

const transportCalls = [];
const remoteFixtures = new Map();
const metadataFixtures = new Map();
let transportResponseMode = "body";
let baselineOperationalState;
let baseUrl;
let rollbackContext;
let server;

function normalizedRemotePath(value) {
  return new URL(String(value), `${RUNTIME.restBaseUrl}/`).pathname;
}

async function netSuiteTransport({ method, path, accept }) {
  transportCalls.push({ method, path: String(path), accept });
  const pathname = normalizedRemotePath(path);
  const segments = pathname.split("/").filter(Boolean);
  let response;
  if (segments.at(-2) === "metadata-catalog") {
    const body = metadataFixtures.get(decodeURIComponent(segments.at(-1) || ""));
    response = body
      ? { status: 200, headers: { "content-type": "application/schema+json" }, body }
      : { status: 404, headers: { "content-type": "application/json" }, body: { error: "not found" } };
  } else {
    const externalId = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) || "");
    const body = remoteFixtures.get(externalId);
    response = body
      ? { status: 200, headers: { "content-type": "application/json" }, body }
      : { status: 404, headers: { "content-type": "application/json" }, body: { error: "not found" } };
  }
  if (transportResponseMode === "primitive") {
    return null;
  }
  if (transportResponseMode === "redirected") {
    return {
      ...response,
      redirected: true,
      url: "https://attacker.invalid/redirected"
    };
  }
  if (transportResponseMode === "fetch") {
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      redirected: false,
      url: String(path),
      async json() {
        return response.body;
      }
    };
  }
  return response;
}

function authenticate(req, res, next) {
  const token = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const actor = ACTORS[token];
  if (!actor) {
    return res.status(401).json({ error: "Login required" });
  }
  req.operator = actor;
  return next();
}

async function request(path, {
  actor,
  method = "GET",
  body,
  headers = {}
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(actor ? { authorization: `Bearer ${actor}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  return { response, payload, text };
}

async function operationalState() {
  const result = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_contracts) AS contracts,
       (SELECT count(*)::int FROM mbt_service_visits) AS visits,
       (SELECT count(*)::int FROM mbt_bin_asset_reservations) AS reservations,
       (SELECT count(*)::int FROM mbt_bin_movements) AS movements,
       (SELECT count(*)::int FROM mbt_billing_versions) AS billing_versions,
       (SELECT count(*)::int FROM mbt_deposit_records) AS deposits,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox,
       (SELECT COALESCE(jsonb_agg(flag_key ORDER BY flag_key), '[]'::jsonb)
          FROM mbt_feature_flags WHERE enabled) AS enabled_flags`
  );
  return result.rows[0];
}

function assertNoStore(response) {
  assert.match(response.headers.get("cache-control") || "", /(?:^|,)\s*no-store\b/i);
}

function semanticExpected(requirement, externalRecordType) {
  const expected = {
    ...(requirement.expected || {}),
    recordType: externalRecordType
  };
  // Derived permission dependencies are server-owned catalog policy.  They are
  // deliberately not accepted as editable mapping evidence.
  delete expected.derivedFromCheckCodes;
  if (requirement.mappingType === "subsidiary") {
    expected.baseCurrency = "CAD";
    expected.legalName = "MBT Sandbox";
  }
  if (requirement.mappingType === "intercompany_customer") {
    Object.assign(expected, {
      externalId: "33",
      entityId: "CUSTOMER-33",
      companyName: "MBT Intercompany Customer",
      currencyId: "1",
      termsId: "2",
      taxItemId: "3",
      creditHold: "OFF",
      subsidiaryId: "33",
      customerType: "COMPANY"
    });
  }
  if (requirement.mappingType === "sales_order_item") {
    expected.subsidiaryIds = ["33"];
  }
  if (requirement.mappingType === "custom_field") {
    expected.fieldType = "string";
    expected.appliesTo = [externalRecordType];
  }
  if (["income_account", "liability_account"].includes(requirement.mappingType)) {
    expected.accountType = requirement.mappingType === "income_account"
      ? "Income"
      : "OthCurrLiab";
    expected.name = `Phase 2 HTTP ${requirement.checkCode}`;
  }
  return expected;
}

function caseInsensitiveFields(requirement) {
  if (requirement.mappingType === "custom_field") {
    return ["fieldType", "appliesTo"];
  }
  if (requirement.mappingType === "subsidiary") {
    return ["baseCurrency"];
  }
  if (requirement.mappingType === "intercompany_customer") {
    return ["customerType"];
  }
  return [];
}

function externalRecordTypeFor(requirement) {
  return ["record_by_id", "metadata_catalog"].includes(requirement.readStrategy)
    ? requirement.allowedRecordTypes[0]
    : requirement.expectedRecordType;
}

function externalIdFor(requirement, index) {
  if (requirement.mappingType === "subsidiary") {
    return "33";
  }
  if (requirement.mappingType === "intercompany_customer") {
    return "33";
  }
  return requirement.checkCode === "item_initial_service"
    ? `P2 HTTP/${RUN_ID}?`
    : `P2_HTTP_${RUN_ID}_${index}`;
}

function installRemoteFixture(requirement, mapping, expected, remoteRecord) {
  if (requirement.readStrategy === "metadata_catalog") {
    const recordType = mapping.externalRecordType;
    const current = metadataFixtures.get(recordType) || {
      components: { schemas: { [recordType]: { properties: {} } } }
    };
    current.components.schemas[recordType].properties[mapping.externalScriptId] = {
      type: expected.fieldType
    };
    metadataFixtures.set(recordType, current);
    return;
  }
  if (requirement.readStrategy === "record_by_id") {
    remoteFixtures.set(mapping.externalId, remoteRecord);
  }
}

function testSubsidiaryId(expected) {
  const configured = expected.subsidiaryNetSuiteId ?? expected.subsidiaryId ?? 33;
  const candidate = Number(configured);
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
}

function testScriptId(requirement, index) {
  return requirement.mappingType === "custom_field" ? `custbody_p2_http_${index}` : null;
}

function testExternalName(index, checkCode) {
  return index === 0
    ? "=HYPERLINK(\"https://invalid.example\",\"hostile\")"
    : `Phase 2 HTTP ${checkCode}`;
}

function mappingInput(requirement, index) {
  const externalRecordType = externalRecordTypeFor(requirement);
  const specialExternalId = externalIdFor(requirement, index);
  const expected = semanticExpected(requirement, externalRecordType);
  const subsidiaryNetSuiteId = testSubsidiaryId(expected);
  const mapping = {
    externalId: specialExternalId,
    externalScriptId: testScriptId(requirement, index),
    externalName: testExternalName(index, requirement.checkCode),
    externalRecordType,
    subsidiaryNetSuiteId,
    configuration: {
      expected,
      caseInsensitiveFields: caseInsensitiveFields(requirement)
    },
    active: true
  };
  const remoteRecord = {
    ...expected,
    id: specialExternalId,
    internalId: specialExternalId,
    scriptId: mapping.externalScriptId,
    name: mapping.externalName,
    recordType: mapping.externalRecordType,
    accountId: RUNTIME.accountId,
    active: true,
    isInactive: false,
    subsidiaryId: mapping.subsidiaryNetSuiteId,
    subsidiaries: mapping.subsidiaryNetSuiteId === null ? [] : [mapping.subsidiaryNetSuiteId],
    readable: true,
    configured: true,
    permissionStatus: requirement.requiredStatus,
    status: requirement.requiredStatus,
    baseCurrency: expected.baseCurrency,
    customerType: expected.customerType,
    appliesTo: expected.appliesTo,
    currency: expected.currencyId ? { id: expected.currencyId } : expected.currency
  };
  if (["income_account", "liability_account"].includes(requirement.mappingType)) {
    delete remoteRecord.accountType;
    remoteRecord.acctName = expected.name;
    remoteRecord.acctType = { id: expected.accountType };
  }
  if (requirement.mappingType === "subsidiary") {
    delete remoteRecord.baseCurrency;
    remoteRecord.legalName = expected.legalName;
    remoteRecord.currency = { id: "1", refName: expected.baseCurrency };
  }
  if (requirement.mappingType === "intercompany_customer") {
    delete remoteRecord.subsidiaryId;
    delete remoteRecord.subsidiaries;
    remoteRecord.subsidiary = { id: String(mapping.subsidiaryNetSuiteId) };
  }
  if (requirement.mappingType === "sales_order_item") {
    delete remoteRecord.subsidiaryId;
    delete remoteRecord.subsidiaryIds;
    delete remoteRecord.subsidiaries;
    remoteRecord.subsidiary = {
      items: [{ id: String(mapping.subsidiaryNetSuiteId) }]
    };
  }
  installRemoteFixture(requirement, mapping, expected, remoteRecord);
  return mapping;
}

function assertCatalogEntry(requirement) {
  for (const key of [
    "checkCode",
    "mappingType",
    "localKey",
    "expectedRecordType",
    "verificationKind",
    "required",
    "requiredStatus",
    "severity",
    "expected",
    "display",
    "readStrategy",
    "allowedRecordTypes",
    "requiredExpectedFields",
    "requiresSubsidiaryNetSuiteId",
    "requiresSubsidiaryMembership",
    "allowedAccountTypes"
  ]) {
    assert.ok(Object.hasOwn(requirement, key), `Catalog entry is missing ${key}: ${JSON.stringify(requirement)}`);
  }
  assert.match(requirement.checkCode, /^[a-z][a-z0-9_]*$/);
  assert.equal(requirement.required, true);
  assert.ok(["error", "warning", "info"].includes(requirement.severity));
  assert.equal(typeof requirement.display, "object");
}

before(async () => {
  baselineOperationalState = await operationalState();
  rollbackContext = await beginRollbackContext();
  await rollbackContext.run(async () => {
    const httpApp = express();
    httpApp.use(express.json({ limit: "1mb" }));
    httpApp.use(authenticate);
    httpApp.use("/api/mbt", createMbtRouter({ netSuiteTransport, netSuiteRuntime: RUNTIME }));
    server = httpApp.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await rollbackContext?.rollback();
  await closeDb();
});

test("P2-F06: every NetSuite readiness endpoint is Admin-only over real HTTP", async () => {
  for (const fixture of API_CASES) {
    const anonymous = await request(fixture.path, {
      method: fixture.method,
      body: fixture.body
    });
    assert.equal(anonymous.response.status, 401, `${fixture.method} ${fixture.path}: ${anonymous.text}`);
    assert.deepEqual(anonymous.payload, { error: "Login required" });

    const denied = await request(fixture.path, {
      actor: "dispatcher",
      method: fixture.method,
      body: fixture.body,
      headers: {
        "x-mbbs-role": "admin",
        "x-mbbs-roles": "admin,mbt_frontdesk,mbt_billing",
        "idempotency-key": `denied-${RUN_ID}`
      }
    });
    assert.equal(denied.response.status, 403, `${fixture.method} ${fixture.path}: ${denied.text}`);
    assert.equal(denied.payload.error, "Admin account required");
    assertNoStore(denied.response);
  }
});

test("P2-F04/F06: malformed preflight UUIDs return stable no-store 400 responses", async () => {
  const fixtures = [
    { method: "GET", path: "/api/mbt/config/netsuite/preflight/not-a-uuid" },
    { method: "GET", path: "/api/mbt/config/netsuite/preflight/not-a-uuid/export?format=json" },
    {
      method: "POST",
      path: "/api/mbt/config/netsuite/preflight/not-a-uuid/signoff",
      body: { auditNote: "Malformed identifiers must not reach PostgreSQL." },
      headers: { "idempotency-key": `p2-invalid-run-${RUN_ID}` }
    }
  ];
  for (const fixture of fixtures) {
    const result = await request(fixture.path, {
      actor: "admin",
      method: fixture.method,
      body: fixture.body,
      headers: fixture.headers
    });
    assert.equal(result.response.status, 400, `${fixture.method} ${fixture.path}: ${result.text}`);
    assert.equal(result.payload.code, "MBT_NETSUITE_PREFLIGHT_RUN_INVALID");
    assertNoStore(result.response);
  }
});

test("P2-F04: latest readiness is explicitly null before the first preflight", async () => {
  const latest = await request("/api/mbt/config/netsuite/preflight/latest", { actor: "admin" });
  assert.equal(latest.response.status, 200, latest.text);
  assertNoStore(latest.response);
  assert.deepEqual(latest.payload, {
    phase: 2,
    runtimeBinding: {
      accountId: RUNTIME.accountId,
      runtimeAccountId: RUNTIME.runtimeAccountId,
      environmentName: "sandbox",
      restBaseUrl: `${RUNTIME.restBaseUrl}/record/v1`,
      directAccessEnabled: true,
      sandboxAccountAllowlist: [RUNTIME.accountId],
      readTimeoutMs: RUNTIME.readTimeoutMs,
      effectivePreflightLeaseSeconds: RUNTIME.preflightLeaseSeconds
    },
    run: null
  });
});

test("P2-R6: mapping HTTP DTO publishes server-owned semantic and subsidiary requirements", async (t) => {
  const listed = await request("/api/mbt/config/netsuite/mappings", { actor: "admin" });
  assert.equal(listed.response.status, 200, listed.text);
  assertNoStore(listed.response);
  const byCode = (checkCode) => {
    const found = listed.payload.requirements.find((candidate) => candidate.checkCode === checkCode);
    assert.ok(found, `Missing HTTP catalog requirement ${checkCode}.`);
    return found;
  };
  const cases = [
    ["mbt_subsidiary", ["legalName", "baseCurrency"], false, false],
    ["customer_33", [
      "entityId",
      "companyName",
      "currencyId",
      "termsId",
      "taxItemId",
      "creditHold"
    ], true, true],
    ["item_initial_service", [], true, true],
    ["custom_field_local_contract_uuid", ["fieldType"], false, false],
    ["account_transport_revenue", ["accountType", "name"], false, true],
    ["account_deposit_liability", ["accountType", "name"], false, true]
  ];
  for (const [
    checkCode,
    requiredExpectedFields,
    requiresSubsidiaryNetSuiteId,
    requiresSubsidiaryMembership
  ] of cases) {
    await t.test(checkCode, () => {
      const requirement = byCode(checkCode);
      assert.deepEqual(requirement.requiredExpectedFields, requiredExpectedFields);
      assert.equal(
        requirement.requiresSubsidiaryNetSuiteId,
        requiresSubsidiaryNetSuiteId
      );
      assert.equal(
        requirement.requiresSubsidiaryMembership,
        requiresSubsidiaryMembership
      );
    });
  }
});

test("P2-F02: mapping HTTP contract is catalog-owned, revisioned, audited, and idempotent", async () => {
  const listed = await request("/api/mbt/config/netsuite/mappings", { actor: "admin" });
  assert.equal(listed.response.status, 200, listed.text);
  assertNoStore(listed.response);
  assert.equal(listed.payload.phase, 2);
  assert.match(listed.payload.configurationHash, SHA256);
  assert.ok(Array.isArray(listed.payload.requirements) && listed.payload.requirements.length > 0);
  listed.payload.requirements.forEach(assertCatalogEntry);
  assert.ok(listed.payload.requirements.some(({ checkCode }) => checkCode === "mbt_subsidiary"));

  const requirement = listed.payload.requirements[0];
  const expectedRevision = Number(requirement.mapping?.revision || 0);
  const body = {
    mappingType: requirement.mappingType,
    localKey: requirement.localKey,
    mapping: mappingInput(requirement, 0),
    expectedRevision,
    reason: "Freeze the Phase 2 real HTTP mapping command"
  };
  const headers = { "idempotency-key": `p2-http-map-${RUN_ID}` };
  const first = await request("/api/mbt/config/netsuite/mappings", {
    actor: "admin",
    method: "PUT",
    headers,
    body
  });
  assert.ok([200, 201].includes(first.response.status), first.text);
  assert.equal(first.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.equal(first.payload.mapping.mappingType, requirement.mappingType);
  assert.equal(first.payload.mapping.localKey, requirement.localKey);
  assert.equal(first.payload.mapping.externalId, body.mapping.externalId);
  assert.equal(first.payload.mapping.revision, expectedRevision + 1);
  assert.match(first.payload.configurationHash, SHA256);
  const externallyVisible = await query(
    "SELECT count(*)::int AS count FROM mbt_netsuite_mappings WHERE mapping_id = $1",
    [first.payload.mapping.mappingId]
  );
  assert.equal(externallyVisible.rows[0].count, 0, "HTTP fixture writes must remain in the rollback context.");

  const replay = await request("/api/mbt/config/netsuite/mappings", {
    actor: "admin",
    method: "PUT",
    headers,
    body
  });
  assert.equal(replay.response.status, first.response.status, replay.text);
  assert.equal(replay.response.headers.get("x-mbt-idempotent-replay"), "true");
  assert.deepEqual(replay.payload, first.payload);

  const changedRetry = await request("/api/mbt/config/netsuite/mappings", {
    actor: "admin",
    method: "PUT",
    headers,
    body: { ...body, reason: "A changed command under the same identity" }
  });
  assert.equal(changedRetry.response.status, 409, changedRetry.text);

  const stale = await request("/api/mbt/config/netsuite/mappings", {
    actor: "admin",
    method: "PUT",
    headers: { "idempotency-key": `p2-http-map-stale-${RUN_ID}` },
    body
  });
  assert.equal(stale.response.status, 409, stale.text);
  assert.equal(stale.payload.code, "MBT_STALE_REVISION");
});

async function saveCompleteCatalog(initial) {
  const saved = new Map();
  for (let index = 0; index < initial.payload.requirements.length; index += 1) {
    const requirement = initial.payload.requirements[index];
    const current = requirement.mapping || null;
    if (index === 0 && current?.externalId === `P2 HTTP/${RUN_ID}?`) {
      saved.set(requirement.checkCode, current);
      continue;
    }
    const mapping = mappingInput(requirement, index);
    const result = await request("/api/mbt/config/netsuite/mappings", {
      actor: "admin",
      method: "PUT",
      headers: { "idempotency-key": `p2-http-catalog-${RUN_ID}-${index}` },
      body: {
        mappingType: requirement.mappingType,
        localKey: requirement.localKey,
        mapping,
        expectedRevision: Number(current?.revision || 0),
        reason: "Complete the deterministic Phase 2 HTTP readiness fixture"
      }
    });
    assert.ok([200, 201].includes(result.response.status), `${requirement.checkCode}: ${result.text}`);
    saved.set(requirement.checkCode, result.payload.mapping);
  }
  return saved;
}

test("P2-F01/F03/F04/F05/R3: injected live transport drives an honest read-only HTTP lifecycle", async () => {
  const initial = await request("/api/mbt/config/netsuite/mappings", { actor: "admin" });
  assert.equal(initial.response.status, 200, initial.text);
  const saved = await saveCompleteCatalog(initial);

  transportCalls.length = 0;
  const started = await request("/api/mbt/config/netsuite/preflight", {
    actor: "admin",
    method: "POST",
    body: {}
  });
  assert.equal(started.response.status, 201, started.text);
  assert.match(started.payload.run.runId, UUID);
  assert.equal(started.payload.run.accountId, RUNTIME.accountId);
  assert.equal(started.payload.run.environmentName, RUNTIME.environmentName);
  assert.equal(started.payload.run.status, "unable_to_verify");
  assert.equal(started.payload.run.ready, false);
  assert.equal(started.payload.run.current, true);
  assert.match(started.payload.run.configurationHash, SHA256);
  assert.equal(started.payload.run.checks.length, initial.payload.requirements.length);
  const byCheckCode = new Map(started.payload.run.checks.map((check) => [check.checkCode, check]));
  for (const requirement of initial.payload.requirements) {
    const check = byCheckCode.get(requirement.checkCode);
    assert.ok(check, requirement.checkCode);
    if (requirement.readStrategy === "unsupported") {
      assert.equal(check.status, "unable_to_verify", requirement.checkCode);
    } else if (requirement.readStrategy === "configured_unproven") {
      assert.equal(check.status, "passed", requirement.checkCode);
    }
  }
  const remoteRequirements = initial.payload.requirements.filter(({ readStrategy }) => (
    readStrategy === "record_by_id" || readStrategy === "metadata_catalog"
  ));
  const expectedRemoteCalls = remoteRequirements.filter(({ readStrategy }) => (
    readStrategy === "record_by_id"
  )).length + new Set(remoteRequirements
    .filter(({ readStrategy }) => readStrategy === "metadata_catalog")
    .map((requirement) => externalRecordTypeFor(requirement))).size;
  assert.equal(transportCalls.length, expectedRemoteCalls);
  for (const call of transportCalls) {
    assert.equal(call.method, "GET", JSON.stringify(call));
    const target = new URL(call.path, `${RUNTIME.restBaseUrl}/`);
    assert.equal(target.origin, new URL(RUNTIME.restBaseUrl).origin);
    assert.ok(target.pathname.startsWith("/services/rest/"), target.pathname);
    assert.doesNotMatch(call.path, /P2 HTTP\//);
    assert.equal(
      call.accept,
      call.path.includes("/metadata-catalog/") ? "application/schema+json" : "application/json"
    );
  }
  assert.ok(transportCalls.some(({ path }) => /P2%20HTTP%2F/i.test(path)), JSON.stringify(transportCalls));
  assert.ok(transportCalls.some(({ path }) => path.includes("/metadata-catalog/salesOrder")));

  const runId = started.payload.run.runId;
  const latest = await request("/api/mbt/config/netsuite/preflight/latest", { actor: "admin" });
  assert.equal(latest.response.status, 200, latest.text);
  assertNoStore(latest.response);
  assert.equal(latest.payload.run.runId, runId);

  const detail = await request(`/api/mbt/config/netsuite/preflight/${runId}`, { actor: "admin" });
  assert.equal(detail.response.status, 200, detail.text);
  assertNoStore(detail.response);
  assert.deepEqual(detail.payload.run, latest.payload.run);

  const jsonReport = await request(
    `/api/mbt/config/netsuite/preflight/${runId}/export?format=json`,
    { actor: "admin" }
  );
  assert.equal(jsonReport.response.status, 200, jsonReport.text);
  assert.match(jsonReport.response.headers.get("content-type") || "", /^application\/json\b/i);
  assert.match(jsonReport.response.headers.get("content-disposition") || "", new RegExp(`${runId}\\.json`));
  assert.equal(jsonReport.payload.runId, runId);
  assert.deepEqual(jsonReport.payload.checks, detail.payload.run.checks);
  assert.doesNotMatch(JSON.stringify(jsonReport.payload), /client.?secret|access.?token|oauth/i);

  const defaultReport = await request(
    `/api/mbt/config/netsuite/preflight/${runId}/export`,
    { actor: "admin" }
  );
  assert.equal(defaultReport.response.status, 200, defaultReport.text);
  assert.match(defaultReport.response.headers.get("content-type") || "", /^application\/json\b/i);
  assert.deepEqual(defaultReport.payload, jsonReport.payload);

  const invalidFormat = await request(
    `/api/mbt/config/netsuite/preflight/${runId}/export?format=html`,
    { actor: "admin" }
  );
  assert.equal(invalidFormat.response.status, 400, invalidFormat.text);
  assert.equal(invalidFormat.payload.code, "MBT_NETSUITE_PREFLIGHT_EXPORT_FORMAT_INVALID");
  assertNoStore(invalidFormat.response);

  const csvReport = await request(
    `/api/mbt/config/netsuite/preflight/${runId}/export?format=csv`,
    { actor: "admin" }
  );
  assert.equal(csvReport.response.status, 200, csvReport.text);
  assert.match(csvReport.response.headers.get("content-type") || "", /^text\/csv\b/i);
  assert.match(csvReport.response.headers.get("content-disposition") || "", new RegExp(`${runId}\\.csv`));
  assert.match(
    csvReport.text,
    /^run_id,account_id,environment_name,configuration_hash,run_status,generated_at,current,signoff_status,sequence_number,check_code,mapping_type,local_key,required,severity,check_status,expected_json,observed_json,message\r?\n/
  );
  assert.doesNotMatch(csvReport.text, /client.?secret|access.?token|oauth/i);

  const refusedSignoff = await request(`/api/mbt/config/netsuite/preflight/${runId}/signoff`, {
    actor: "admin",
    method: "POST",
    headers: { "idempotency-key": `p2-http-signoff-${RUN_ID}` },
    body: { auditNote: "This incomplete evidence must not be signable." }
  });
  assert.equal(refusedSignoff.response.status, 409, refusedSignoff.text);
  assert.equal(refusedSignoff.payload.code, "MBT_NETSUITE_PREFLIGHT_NOT_SIGNABLE");

  const firstRequirement = initial.payload.requirements[0];
  const firstMapping = saved.get(firstRequirement.checkCode);
  const changed = await request("/api/mbt/config/netsuite/mappings", {
    actor: "admin",
    method: "PUT",
    headers: { "idempotency-key": `p2-http-invalidate-${RUN_ID}` },
    body: {
      mappingType: firstRequirement.mappingType,
      localKey: firstRequirement.localKey,
      mapping: {
        externalId: firstMapping.externalId,
        externalScriptId: firstMapping.externalScriptId,
        externalName: `${firstMapping.externalName} revised`,
        externalRecordType: firstMapping.externalRecordType,
        subsidiaryNetSuiteId: firstMapping.subsidiaryNetSuiteId,
        configuration: firstMapping.configuration,
        active: firstMapping.active
      },
      expectedRevision: firstMapping.revision,
      reason: "Prove that any mapping revision invalidates the current signoff"
    }
  });
  assert.equal(changed.response.status, 200, changed.text);
  assert.notEqual(changed.payload.configurationHash, started.payload.run.configurationHash);

  const invalidated = await request("/api/mbt/config/netsuite/preflight/latest", { actor: "admin" });
  assert.equal(invalidated.response.status, 200, invalidated.text);
  assert.equal(invalidated.payload.run.runId, runId);
  assert.equal(invalidated.payload.run.current, false);
  assert.equal(invalidated.payload.run.ready, false);
  assert.equal(invalidated.payload.run.signoff, null);

  assert.deepEqual(await operationalState(), baselineOperationalState);
});

test("P2-F01/F03: HTTP preflight bounds fetch-style, primitive, and redirected transport responses", async () => {
  try {
    for (const mode of ["fetch", "primitive", "redirected"]) {
      transportResponseMode = mode;
      const result = await request("/api/mbt/config/netsuite/preflight", {
        actor: "admin",
        method: "POST",
        body: {}
      });
      assert.equal(result.response.status, 201, `${mode}: ${result.text}`);
      assert.match(result.payload.run.runId, UUID);
      assert.equal(result.payload.run.status, "unable_to_verify");
      assert.equal(result.payload.run.current, true);
      assert.equal(result.payload.run.ready, false);
      if (mode !== "fetch") {
        const remoteChecks = result.payload.run.checks.filter(({ checkCode }) => (
          !["customer_sales_order_form", "sot_sales_order_form", "customer_deposit_form"].includes(checkCode)
        ));
        assert.ok(remoteChecks.some(({ status }) => status === "unable_to_verify"));
      }
    }
  } finally {
    transportResponseMode = "body";
  }
});
