import assert from "node:assert/strict";
import express from "express";
import test, { after, before, beforeEach } from "node:test";

import { closeDb } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { createMbtRouter } from "../../../src/mbt/router.js";

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BATCH_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ROW_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SNAPSHOT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ACTORS = Object.freeze({
  billing: Object.freeze({
    id: "p3-billing-http-operator",
    role: "mbt_billing",
    roles: Object.freeze(["mbt_billing"]),
    homeRoute: "/mbt/billing"
  }),
  dispatcher: Object.freeze({
    id: "p3-billing-http-dispatcher",
    role: "dispatcher",
    roles: Object.freeze(["dispatcher"]),
    homeRoute: "/dispatch"
  })
});

let baseUrl;
let server;
let capabilityAllowed = true;
const calls = [];
const capabilityCalls = [];

/** @param {string} operation @param {Record<string, unknown>} input @param {number} status */
function commandResult(operation, input, status) {
  calls.push({ operation, input });
  return {
    status,
    replayed: false,
    body: {
      schemaVersion: `mbt-billing-${operation}-http-v1`,
      operation,
      billingCaseId: CASE_ID,
      billingVersionId: VERSION_ID
    }
  };
}

const billingService = Object.freeze({
  async listLocalBillingCases(input) {
    calls.push({ operation: "list_cases", input });
    return { schemaVersion: "mbt-local-billing-queue-v1", postingMode: "local_only", items: [], nextCursor: null };
  },
  async getLocalBillingCase(caseId, actor) {
    calls.push({ operation: "get_case", input: { caseId, actor } });
    return { schemaVersion: "mbt-local-billing-case-v1", billingCaseId: caseId, postingMode: "local_only", versions: [] };
  },
  async calculateMbtBillingCase(input) {
    return commandResult("calculate", input, 201);
  },
  async approveLocalBillingVersion(input) {
    return commandResult("approve", input, 200);
  },
  async generateMbbsShadowBillingFromSnapshots(input) {
    return commandResult("generate_mbbs", input, 201);
  }
});

const reconciliationService = Object.freeze({
  comparePilotEvidence() {
    throw new Error("The HTTP adapter must not invoke the pure comparison directly.");
  },
  async listPilotReconciliationBatches(input) {
    calls.push({ operation: "list_batches", input });
    return { schemaVersion: "mbt-pilot-reconciliation-list-v1", items: [], nextCursor: null };
  },
  async getPilotReconciliationBatch(batchId, actor) {
    calls.push({ operation: "get_batch", input: { batchId, actor } });
    return { schemaVersion: "mbt-pilot-reconciliation-v1", batchId, rows: [] };
  },
  async createPilotReconciliationBatch(input) {
    return commandResult("create_batch", input, 201);
  },
  async resolvePilotVariance(input) {
    return commandResult("resolve_variance", input, 201);
  }
});

function authenticate(req, res, next) {
  const token = String(req.get("authorization") || "").replace(/^Bearer\s+/iu, "");
  const actor = ACTORS[token];
  if (!actor) {
    res.setHeader("cache-control", "no-store");
    return res.status(401).json({ error: "Login required" });
  }
  req.operator = actor;
  return next();
}

async function authorizePhase3Capability(input) {
  capabilityCalls.push(input);
  assert.equal(input.capability, "billingOperations");
  if (!capabilityAllowed) {
    throw new MbtError({
      status: 409,
      code: "MBT_CAPABILITY_DISABLED",
      message: "This MBT capability is disabled.",
      details: { reason: "environment_capability_disabled" }
    });
  }
  return { enabled: true, reason: null };
}

async function request(path, { actor, method = "GET", body, idempotencyKey } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(actor ? { authorization: `Bearer ${actor}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
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
  return { response, payload };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(authenticate);
  app.use("/api/mbt", createMbtRouter({
    billingService,
    reconciliationService,
    authorizePhase3Capability,
    netSuiteTransport: async () => {
      throw new Error("P3.10 HTTP must remain local-only.");
    }
  }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  calls.length = 0;
  capabilityCalls.length = 0;
  capabilityAllowed = true;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
  await closeDb();
});

test("P3-F23/P3-F27 HTTP: authentication and billing authority deny before every service", async () => {
  assert.equal((await request("/api/mbt/billing/cases")).response.status, 401);
  assert.equal((await request("/api/mbt/billing/cases", { actor: "dispatcher" })).response.status, 403);
  assert.equal((await request(`/api/mbt/billing/cases/${CASE_ID}/calculate`, {
    actor: "dispatcher",
    method: "POST",
    body: {},
    idempotencyKey: "p3-billing-http-denied"
  })).response.status, 403);
  assert.equal(calls.length, 0);
  assert.equal(capabilityCalls.length, 0);
});

test("P3-F27 HTTP: a closed operational gate preserves read-only recovery and denies mutations", async () => {
  capabilityAllowed = false;
  const status = await request("/api/mbt/billing/status", { actor: "billing" });
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.enabled, false);
  assert.equal(status.payload.readOnlyRecoveryAvailable, true);
  assert.equal(status.payload.netSuiteWritesEnabled, false);

  const cases = await request("/api/mbt/billing/cases?status=ready&billingMonth=2037-08&limit=7", { actor: "billing" });
  const detail = await request(`/api/mbt/billing/cases/${CASE_ID}`, { actor: "billing" });
  const batches = await request("/api/mbt/reconciliation/batches?limit=5", { actor: "billing" });
  const batch = await request(`/api/mbt/reconciliation/batches/${BATCH_ID}`, { actor: "billing" });
  for (const result of [cases, detail, batches, batch]) {
    assert.equal(result.response.status, 200);
  }
  assert.deepEqual(calls.map(({ operation }) => operation), [
    "list_cases", "get_case", "list_batches", "get_batch"
  ]);
  assert.equal(calls[0].input.billingMonth, "2037-08");

  calls.length = 0;
  const denied = await request(`/api/mbt/billing/cases/${CASE_ID}/calculate`, {
    actor: "billing",
    method: "POST",
    body: { expectedRevision: 1 },
    idempotencyKey: "p3-billing-http-closed"
  });
  assert.equal(denied.response.status, 409);
  assert.equal(denied.payload.code, "MBT_CAPABILITY_DISABLED");
  assert.equal(calls.length, 0);
});

test("P3-F25/P3-F27 HTTP: enabled commands replace forged actor and bind exact request identity", async () => {
  const calculated = await request(`/api/mbt/billing/cases/${CASE_ID}/calculate`, {
    actor: "billing",
    method: "POST",
    idempotencyKey: "p3-billing-http-calculate",
    body: {
      actor: { operatorId: "forged", roles: ["admin"] },
      billingCaseId: VERSION_ID,
      serviceVisitId: VERSION_ID,
      distanceSnapshotId: VERSION_ID,
      expectedRevision: 1,
      waiver: {
        amountMinor: 2500,
        reason: "Approved service recovery",
        description: "Extension fee waiver"
      },
      reason: "Synthetic HTTP calculation"
    }
  });
  assert.equal(calculated.response.status, 201, JSON.stringify(calculated.payload));
  assert.equal(calculated.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.match(calculated.response.headers.get("cache-control") || "", /no-store/u);
  assert.equal(calls[0].operation, "calculate");
  assert.deepEqual(calls[0].input.actor, {
    operatorId: ACTORS.billing.id,
    roles: ["mbt_billing"]
  });
  assert.equal(calls[0].input.billingCaseId, CASE_ID);
  assert.equal(calls[0].input.idempotencyKey, "p3-billing-http-calculate");
  assert.deepEqual(calls[0].input.waiver, {
    amountMinor: 2500,
    reason: "Approved service recovery",
    description: "Extension fee waiver"
  });
  assert.match(calls[0].input.correlationId, /^[0-9a-f-]{36}$/iu);
  assert.match(calls[0].input.requestId, /^[0-9a-f-]{36}$/iu);
  assert.deepEqual(capabilityCalls[0], {
    capability: "billingOperations",
    pilotAuthorized: true
  });
});

test("P3-F26/P3-F28 HTTP: MBBS generation and reconciliation commands remain local command adapters", async () => {
  const captured = [];
  const commands = [
    ["/api/mbt/billing/mbbs/generate", {
      currency: "CAD", completedLoadSnapshotIds: [SNAPSHOT_ID], reason: "Generate"
    }, "generate_mbbs"],
    ["/api/mbt/reconciliation/batches", {
      batchReference: "MANUAL-1", manualSource: "pilot", comparisons: [{}], reason: "Compare"
    }, "create_batch"],
    [`/api/mbt/reconciliation/batches/${BATCH_ID}/resolve`, {
      reconciliationRowId: ROW_ID, decision: "evidence_only", note: "Retain"
    }, "resolve_variance"]
  ];
  for (const [path, body, operation] of commands) {
    calls.length = 0;
    const result = await request(path, {
      actor: "billing",
      method: "POST",
      body,
      idempotencyKey: `p3-billing-http-${operation}`
    });
    assert.equal(result.response.status, 201, `${operation}: ${JSON.stringify(result.payload)}`);
    assert.equal(calls[0].operation, operation);
    assert.deepEqual(calls[0].input.actor, {
      operatorId: ACTORS.billing.id,
      roles: ["mbt_billing"]
    });
    captured.push(calls[0]);
  }
  const generation = captured.find(({ operation }) => operation === "generate_mbbs");
  assert.deepEqual(generation?.input.completedLoadSnapshotIds, [SNAPSHOT_ID]);
  assert.equal(Object.hasOwn(generation?.input || {}, "loads"), false);
  assert.equal(captured.at(-1).input.reconciliationBatchId, BATCH_ID);
  assert.equal(captured.at(-1).input.reconciliationRowId, ROW_ID);
});

test("P3-F27 HTTP: malformed identity and absent idempotency fail before service; no posting route exists", async () => {
  const malformed = await request("/api/mbt/billing/cases/not-a-uuid/calculate", {
    actor: "billing", method: "POST", body: {}, idempotencyKey: "p3-billing-http-malformed"
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.payload.code, "MBT_BILLING_INPUT_INVALID");

  const noKey = await request(`/api/mbt/billing/cases/${CASE_ID}/approve-local`, {
    actor: "billing", method: "POST", body: { billingVersionId: VERSION_ID }
  });
  assert.equal(noKey.response.status, 400);
  assert.equal(noKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");

  const posting = await request(`/api/mbt/billing/cases/${CASE_ID}/post`, {
    actor: "billing", method: "POST", body: {}, idempotencyKey: "p3-billing-http-post"
  });
  assert.equal(posting.response.status, 404);
  assert.equal(calls.length, 0);
});
