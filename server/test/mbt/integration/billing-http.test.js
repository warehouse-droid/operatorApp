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
const CANDIDATE_ID = "eyJ2IjoxLCJraW5kIjoiZHJpdmVyIiwicGxhbklkIjpudWxsLCJsb2FkSWQiOiJMT0FELTEifQ";
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

const candidateService = Object.freeze({
  async searchMbbsBillingCustomers(input) {
    calls.push({ operation: "search_mbbs_customers", input });
    return {
      schemaVersion: "mbbs-billing-customer-search-v1",
      search: input.search,
      items: [{ netsuiteId: "123", entityNumber: "MBBS", displayName: "MBBS", currency: "CAD" }]
    };
  },
  async listMbbsBillingCandidates(input) {
    calls.push({ operation: "list_mbbs_candidates", input });
    return { schemaVersion: "mbbs-billing-candidates-v1", postingMode: "local_only_preview", items: [] };
  },
  async previewMbbsBillingCandidate(input, dependencies) {
    calls.push({ operation: "preview_mbbs_candidate", input, dependencies });
    const route = await dependencies.resolveDistance({ originYardCode: "2967", destinationAddressText: "Toronto" });
    return {
      schemaVersion: "mbbs-billing-candidate-preview-v1",
      postingMode: "local_only_preview",
      externalWork: null,
      distanceMetres: route.providerMetres,
      charge: { itemCode: "DELIVERY_CHARGE_MBBS", amountMinor: 25000, currency: "CAD" }
    };
  },
  async previewMbbsBillingCandidatesBatch(input, dependencies) {
    calls.push({ operation: "preview_mbbs_candidates_batch", input, dependencies });
    const route = await dependencies.resolveDistance({ originYardCode: "2967", destinationAddressText: "Toronto" });
    return {
      schemaVersion: "mbbs-billing-candidate-batch-preview-v1",
      postingMode: "local_only_preview",
      externalWork: null,
      requestedCount: input.candidateIds.length,
      successCount: input.candidateIds.length,
      failureCount: 0,
      results: input.candidateIds.map((candidateId) => ({
        candidateId,
        status: "calculated",
        distanceMetres: route.providerMetres,
        charge: { itemCode: "DELIVERY_CHARGE_MBBS", amountMinor: 25000, currency: "CAD" }
      }))
    };
  },
  async createMbbsBillingCasesFromCandidates(input, dependencies) {
    calls.push({ operation: "create_mbbs_candidate_cases", input, dependencies });
    await dependencies.resolveDistance({ originAddressText: "Vendor", destinationAddressText: "MBBS" });
    return {
      status: 201,
      replayed: false,
      body: {
        schemaVersion: "mbbs-billing-candidate-batch-create-v1",
        requestedCandidateCount: input.candidateIds.length,
        durableCaseCount: input.candidateIds.length,
        postingMode: "local_only",
        externalWork: null
      }
    };
  },
  async setMbbsBillingCandidateAddressOverride(input) {
    calls.push({ operation: "set_mbbs_candidate_address_override", input });
    return {
      status: 200,
      replayed: false,
      body: {
        schemaVersion: "mbbs-billing-address-override-v1",
        candidateId: input.candidateId,
        destinationAddressText: input.destinationAddressText,
        revision: 1,
        postingMode: "local_only"
      }
    };
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
    billingCandidateService: candidateService,
    reconciliationService,
    authorizePhase3Capability,
    frontdeskPricing: {
      async resolveDistance() {
        return { providerMetres: 31_000 };
      },
      async resolveTaxPolicy() {
        throw new Error("The MBBS preview must not resolve customer tax.");
      }
    },
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
  const candidates = await request("/api/mbt/billing/mbbs/candidates?limit=5", { actor: "billing" });
  const batches = await request("/api/mbt/reconciliation/batches?limit=5", { actor: "billing" });
  const batch = await request(`/api/mbt/reconciliation/batches/${BATCH_ID}`, { actor: "billing" });
  for (const result of [cases, detail, candidates, batches, batch]) {
    assert.equal(result.response.status, 200);
  }
  assert.deepEqual(calls.map(({ operation }) => operation), [
    "list_cases", "get_case", "list_mbbs_candidates", "list_batches", "get_batch"
  ]);
  assert.equal(calls[0].input.billingMonth, "2037-08");

  const deniedPreview = await request(`/api/mbt/billing/mbbs/candidates/${CANDIDATE_ID}/preview`, {
    actor: "billing", method: "POST", body: {}
  });
  assert.equal(deniedPreview.response.status, 409);

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

test("MBBS candidate HTTP lists retained completions and previews the exact active item locally", async () => {
  const listed = await request("/api/mbt/billing/mbbs/candidates?limit=17&completedMonth=2038-08&completedDate=2038-08-10&search=SO-123", { actor: "billing" });
  assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
  assert.equal(calls[0].operation, "list_mbbs_candidates");
  assert.equal(calls[0].input.limit, 17);
  assert.equal(calls[0].input.completedMonth, "2038-08");
  assert.equal(calls[0].input.completedDate, "2038-08-10");
  assert.equal(calls[0].input.search, "SO-123");
  assert.deepEqual(calls[0].input.actor, {
    operatorId: ACTORS.billing.id,
    roles: ["mbt_billing"]
  });

  calls.length = 0;
  const preview = await request(`/api/mbt/billing/mbbs/candidates/${CANDIDATE_ID}/preview`, {
    actor: "billing",
    method: "POST",
    body: {
      actor: { operatorId: "forged", roles: ["admin"] },
      candidateId: "forged",
      completedMonth: "2038-08",
      completedDate: "2038-08-10",
      rateCardVersionId: VERSION_ID
    }
  });
  assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
  assert.equal(preview.payload.charge.itemCode, "DELIVERY_CHARGE_MBBS");
  assert.equal(preview.payload.postingMode, "local_only_preview");
  assert.equal(preview.payload.externalWork, null);
  assert.equal(calls[0].operation, "preview_mbbs_candidate");
  assert.equal(calls[0].input.candidateId, CANDIDATE_ID);
  assert.equal(calls[0].input.completedMonth, "2038-08");
  assert.equal(calls[0].input.completedDate, "2038-08-10");
  assert.equal(calls[0].input.rateCardVersionId, VERSION_ID);
  assert.equal(calls[0].input.actor.operatorId, ACTORS.billing.id);
  assert.equal(typeof calls[0].dependencies.resolveDistance, "function");

  calls.length = 0;
  const batch = await request("/api/mbt/billing/mbbs/candidates/batch-preview", {
    actor: "billing",
    method: "POST",
    body: {
      actor: { operatorId: "forged", roles: ["admin"] },
      candidateIds: [CANDIDATE_ID],
      completedMonth: "2038-08",
      completedDate: "2038-08-10",
      rateCardVersionId: VERSION_ID
    }
  });
  assert.equal(batch.response.status, 200, JSON.stringify(batch.payload));
  assert.equal(batch.payload.postingMode, "local_only_preview");
  assert.equal(batch.payload.externalWork, null);
  assert.equal(calls[0].operation, "preview_mbbs_candidates_batch");
  assert.deepEqual(calls[0].input.candidateIds, [CANDIDATE_ID]);
  assert.equal(calls[0].input.completedMonth, "2038-08");
  assert.equal(calls[0].input.completedDate, "2038-08-10");
  assert.equal(calls[0].input.rateCardVersionId, VERSION_ID);
  assert.equal(calls[0].input.actor.operatorId, ACTORS.billing.id);
  assert.equal(typeof calls[0].dependencies.resolveDistance, "function");

  calls.length = 0;
  const address = await request(`/api/mbt/billing/mbbs/candidates/${CANDIDATE_ID}/address-override`, {
    actor: "billing",
    method: "PUT",
    idempotencyKey: "p3-billing-address-override",
    body: {
      actor: { operatorId: "forged", roles: ["admin"] },
      candidateId: "forged",
      completedMonth: "2038-08",
      destinationAddressText: "200 King Street West, Toronto, ON",
      expectedRevision: 0,
      reason: "Verified with the customer"
    }
  });
  assert.equal(address.response.status, 200, JSON.stringify(address.payload));
  assert.equal(address.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.equal(calls[0].operation, "set_mbbs_candidate_address_override");
  assert.equal(calls[0].input.candidateId, CANDIDATE_ID);
  assert.equal(calls[0].input.completedMonth, "2038-08");
  assert.equal(calls[0].input.destinationAddressText, "200 King Street West, Toronto, ON");
  assert.equal(calls[0].input.expectedRevision, 0);
  assert.equal(calls[0].input.reason, "Verified with the customer");
  assert.equal(calls[0].input.idempotencyKey, "p3-billing-address-override");
  assert.equal(calls[0].input.actor.operatorId, ACTORS.billing.id);
});

test("MBBS candidate HTTP searches canonical customers and converts one server-owned batch atomically", async () => {
  const customers = await request("/api/mbt/billing/mbbs/customers?search=MBBS&limit=12", { actor: "billing" });
  assert.equal(customers.response.status, 200, JSON.stringify(customers.payload));
  assert.equal(calls[0].operation, "search_mbbs_customers");
  assert.equal(calls[0].input.search, "MBBS");
  assert.equal(calls[0].input.limit, 12);
  assert.equal(calls[0].input.actor.operatorId, ACTORS.billing.id);

  calls.length = 0;
  const converted = await request("/api/mbt/billing/mbbs/candidates/batch-create", {
    actor: "billing",
    method: "POST",
    idempotencyKey: "p3-billing-http-candidate-create",
    body: {
      actor: { operatorId: "forged", roles: ["admin"] },
      candidateIds: [CANDIDATE_ID],
      completedMonth: "2038-08",
      completedDate: "2038-08-10",
      rateCardVersionId: VERSION_ID,
      customerNetsuiteId: "123",
      reason: "Convert a verified batch"
    }
  });
  assert.equal(converted.response.status, 201, JSON.stringify(converted.payload));
  assert.equal(converted.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.equal(converted.payload.postingMode, "local_only");
  assert.equal(converted.payload.externalWork, null);
  assert.equal(calls[0].operation, "create_mbbs_candidate_cases");
  assert.equal(calls[0].input.actor.operatorId, ACTORS.billing.id);
  assert.equal(calls[0].input.idempotencyKey, "p3-billing-http-candidate-create");
  assert.equal(calls[0].input.completedDate, "2038-08-10");
  assert.equal(calls[0].input.customerNetsuiteId, "123");
  assert.equal(typeof calls[0].dependencies.resolveDistance, "function");
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
