import assert from "node:assert/strict";
import express from "express";
import test, { after, before, beforeEach } from "node:test";

import { closeDb } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { createMbtRouter } from "../../../src/mbt/router.js";

const VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTORS = Object.freeze({
  admin: Object.freeze({
    id: "p3-rate-http-admin",
    role: "admin",
    roles: Object.freeze(["admin"]),
    homeRoute: "/admin"
  }),
  dispatcher: Object.freeze({
    id: "p3-rate-http-dispatcher",
    role: "dispatcher",
    roles: Object.freeze(["dispatcher"]),
    homeRoute: "/dispatch"
  }),
  operator: Object.freeze({
    id: "p3-rate-http-operator",
    role: "operator",
    roles: Object.freeze(["operator"]),
    homeRoute: "/operator"
  })
});
const PUBLIC_VERSION = Object.freeze({
  rateCardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  rateCardVersionId: VERSION_ID,
  rateCardCode: "P3_HTTP_RATE",
  versionNumber: 1,
  status: "draft",
  revision: 1,
  currency: "CAD"
});
const RATE_DETAIL = Object.freeze({
  schemaVersion: "mbt-rate-card-detail-v1",
  version: PUBLIC_VERSION,
  graph: Object.freeze({
    rateCard: Object.freeze({
      rateCardCode: "P3_HTTP_RATE",
      displayName: "Synthetic HTTP rate",
      currency: "CAD"
    }),
    version: Object.freeze({ versionNumber: 1 }),
    distanceBands: Object.freeze([]),
    components: Object.freeze([]),
    dumpTariffs: Object.freeze([]),
    depositRules: Object.freeze([])
  })
});
const CUSTOMER_CHARGE_CONFIGURATION = Object.freeze({
  schemaVersion: "mbt-frontdesk-customer-charge-admin-configuration-v1",
  rateCardVersionId: VERSION_ID,
  revision: 1,
  complete: true,
  aggregateItems: Object.freeze([]),
  fixedDumpItems: Object.freeze([]),
  aggregateDistanceBands: Object.freeze([]),
  aggregateLoadingFeeMinor: 5_000
});

let baseUrl;
let server;
let capabilityAllowed = true;
let netSuiteTransportCalls = 0;
const calls = [];

const rateCardService = Object.freeze({
  async listLocalRateCards(input) {
    calls.push({ method: "list", input });
    return {
      schemaVersion: "mbt-rate-cards-v1",
      items: [PUBLIC_VERSION],
      nextCursor: null
    };
  },
  async applyLocalRateCardDraft(input) {
    calls.push({ method: "create", input });
    return {
      status: 201,
      replayed: false,
      body: { schemaVersion: "mbt-rate-card-v1", version: PUBLIC_VERSION }
    };
  },
  async getLocalRateCardGraph(input) {
    calls.push({ method: "detail", input });
    return RATE_DETAIL;
  },
  async replaceLocalRateCardDraft(input) {
    calls.push({ method: "replace", input });
    return {
      status: 200,
      replayed: false,
      body: {
        schemaVersion: "mbt-rate-card-v1",
        version: { ...PUBLIC_VERSION, revision: Number(input.expectedRevision) + 1 }
      }
    };
  },
  async validateLocalRateCardVersion(input) {
    calls.push({ method: "validate", input });
    return {
      status: 200,
      replayed: false,
      body: {
        schemaVersion: "mbt-rate-card-v1",
        version: { ...PUBLIC_VERSION, status: "validated", revision: 2 }
      }
    };
  },
  async activateLocalRateCardVersion(input) {
    calls.push({ method: "activate", input });
    return {
      status: 200,
      replayed: true,
      body: {
        schemaVersion: "mbt-rate-card-v1",
        version: { ...PUBLIC_VERSION, status: "active", revision: 3 }
      }
    };
  }
});

const customerChargeService = Object.freeze({
  async getFrontdeskCustomerChargeAdminConfiguration(input) {
    calls.push({ method: "customer-charge-detail", input });
    return CUSTOMER_CHARGE_CONFIGURATION;
  },
  async replaceFrontdeskCustomerChargeConfiguration(input) {
    calls.push({ method: "customer-charge-replace", input });
    return {
      status: 201,
      replayed: false,
      body: {
        schemaVersion: "mbt-frontdesk-customer-charge-admin-configuration-command-v1",
        configuration: CUSTOMER_CHARGE_CONFIGURATION
      }
    };
  }
});

function authenticate(req, res, next) {
  const token = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const actor = ACTORS[token];
  if (!actor) {
    res.setHeader("cache-control", "no-store");
    return res.status(401).json({ error: "Login required" });
  }
  req.operator = actor;
  return next();
}

async function authorizePhase3Capability({ capability }) {
  assert.equal(capability, "masterData");
  if (!capabilityAllowed) {
    throw new MbtError({
      status: 409,
      code: "MBT_CAPABILITY_DISABLED",
      message: "This MBT capability is disabled.",
      details: { capability }
    });
  }
}

async function request(path, {
  actor,
  method = "GET",
  body,
  idempotencyKey
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(actor ? { authorization: `Bearer ${actor}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(authenticate);
  app.use("/api/mbt", createMbtRouter({
    rateCardService,
    customerChargeService,
    authorizePhase3Capability,
    netSuiteTransport: async () => {
      netSuiteTransportCalls += 1;
      throw new Error("Rate-card configuration must remain local-only.");
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
  capabilityAllowed = true;
  netSuiteTransportCalls = 0;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
  await closeDb();
});

test("P3-F12 HTTP: private rate-card reads are Admin-only, no-store, and local-only", async () => {
  const anonymous = await request("/api/mbt/config/rate-cards");
  assert.equal(anonymous.response.status, 401);

  for (const actor of ["dispatcher", "operator"]) {
    const forbidden = await request("/api/mbt/config/rate-cards", { actor });
    assert.equal(forbidden.response.status, 403);
    assert.match(forbidden.response.headers.get("cache-control") || "", /no-store/);
  }

  const admin = await request(
    "/api/mbt/config/rate-cards?query=P3_HTTP&status=draft&limit=20",
    { actor: "admin" }
  );
  assert.equal(admin.response.status, 200, JSON.stringify(admin.payload));
  assert.match(admin.response.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(admin.payload, {
    schemaVersion: "mbt-rate-cards-v1",
    items: [PUBLIC_VERSION],
    nextCursor: null
  });
  assert.deepEqual(calls, [{
    method: "list",
    input: { query: "P3_HTTP", status: "draft", limit: 20, cursor: null }
  }]);
  assert.equal(netSuiteTransportCalls, 0);
});

test("customer-charge pricing configuration is Admin-only, optimistic, audited, and local-only", async () => {
  const forbidden = await request(`/api/mbt/config/customer-charges/${VERSION_ID}`, {
    actor: "dispatcher"
  });
  assert.equal(forbidden.response.status, 403);

  const detail = await request(`/api/mbt/config/customer-charges/${VERSION_ID}`, { actor: "admin" });
  assert.equal(detail.response.status, 200, JSON.stringify(detail.payload));
  assert.match(detail.response.headers.get("cache-control") || "", /no-store/u);
  assert.deepEqual(detail.payload, CUSTOMER_CHARGE_CONFIGURATION);

  const body = {
    actor: { operatorId: "browser-forgery", roles: ["admin"] },
    expectedRevision: 0,
    aggregateItems: [{ itemCode: "AGG_HPB", amountMinor: 6_500, densityLbsPerYard: 2_600 }],
    fixedDumpItems: [{ itemCode: "DUMP_SOIL", amountMinor: 85_000 }],
    aggregateDistanceBands: [
      { bandCode: "AGG_0_30", minimumMetres: 0, maximumMetres: 30_000, amountMinor: 15_000 }
    ],
    reason: "Configure customer charge rates"
  };
  const withoutKey = await request(`/api/mbt/config/customer-charges/${VERSION_ID}`, {
    actor: "admin", method: "PUT", body
  });
  assert.equal(withoutKey.response.status, 400);
  assert.equal(withoutKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");

  const saved = await request(`/api/mbt/config/customer-charges/${VERSION_ID}`, {
    actor: "admin",
    method: "PUT",
    body,
    idempotencyKey: "customer-charge-configuration-http"
  });
  assert.equal(saved.response.status, 201, JSON.stringify(saved.payload));
  assert.equal(saved.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.deepEqual(calls.map(({ method }) => method), [
    "customer-charge-detail",
    "customer-charge-replace"
  ]);
  assert.deepEqual(calls[0].input.actor, {
    operatorId: ACTORS.admin.id,
    roles: ["admin"]
  });
  assert.equal(calls[1].input.actor.operatorId, ACTORS.admin.id);
  assert.equal(calls[1].input.rateCardVersionId, VERSION_ID);
  assert.equal(calls[1].input.expectedRevision, 0);
  assert.deepEqual(calls[1].input.aggregateItems, body.aggregateItems);
  assert.equal(calls[1].input.idempotencyKey, "customer-charge-configuration-http");
  assert.equal(netSuiteTransportCalls, 0);
});

test("P3-F12 HTTP: create, validate, and activate bind the server actor and require idempotency", async () => {
  const graph = {
    rateCard: {
      rateCardCode: "P3_HTTP_RATE",
      displayName: "Synthetic HTTP rate",
      currency: "CAD"
    },
    version: { versionNumber: 1, effectiveFrom: "2036-08-03T00:00:00.000Z" },
    distanceBands: [],
    components: [],
    dumpTariffs: [],
    depositRules: []
  };
  const forgedBody = {
    actor: { operatorId: "browser-forgery", roles: ["admin"] },
    sourceKind: "manual",
    graph,
    reason: "Create synthetic rate graph"
  };

  const dispatcher = await request("/api/mbt/config/rate-cards", {
    actor: "dispatcher",
    method: "POST",
    body: forgedBody,
    idempotencyKey: "p3-rate-http-forbidden"
  });
  assert.equal(dispatcher.response.status, 403);

  const withoutKey = await request("/api/mbt/config/rate-cards", {
    actor: "admin",
    method: "POST",
    body: forgedBody
  });
  assert.equal(withoutKey.response.status, 400);
  assert.equal(withoutKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");

  const created = await request("/api/mbt/config/rate-cards", {
    actor: "admin",
    method: "POST",
    body: forgedBody,
    idempotencyKey: "p3-rate-http-create"
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.match(created.response.headers.get("cache-control") || "", /no-store/);

  const commandBody = {
    actor: { operatorId: "browser-forgery", roles: ["admin"] },
    expectedRevision: 1,
    reason: "Approve synthetic rate graph"
  };
  const validated = await request(`/api/mbt/config/rate-cards/${VERSION_ID}/validate`, {
    actor: "admin",
    method: "POST",
    body: commandBody,
    idempotencyKey: "p3-rate-http-validate"
  });
  assert.equal(validated.response.status, 200, JSON.stringify(validated.payload));
  assert.equal(validated.response.headers.get("x-mbt-idempotent-replay"), "false");

  const activated = await request(`/api/mbt/config/rate-cards/${VERSION_ID}/activate`, {
    actor: "admin",
    method: "POST",
    body: commandBody,
    idempotencyKey: "p3-rate-http-activate"
  });
  assert.equal(activated.response.status, 200, JSON.stringify(activated.payload));
  assert.equal(activated.response.headers.get("x-mbt-idempotent-replay"), "true");

  assert.deepEqual(calls.map(({ method }) => method), ["create", "validate", "activate"]);
  for (const call of calls) {
    assert.deepEqual(call.input.actor, {
      operatorId: ACTORS.admin.id,
      roles: ["admin"]
    });
    assert.equal(Object.hasOwn(call.input, "role"), false);
  }
  assert.deepEqual(calls[0].input.graph, graph);
  assert.equal(calls[0].input.sourceKind, "manual");
  assert.equal(calls[0].input.idempotencyKey, "p3-rate-http-create");
  assert.equal(calls[1].input.rateCardVersionId, VERSION_ID);
  assert.equal(calls[1].input.expectedRevision, 1);
  assert.equal(calls[1].input.idempotencyKey, "p3-rate-http-validate");
  assert.equal(calls[2].input.rateCardVersionId, VERSION_ID);
  assert.equal(calls[2].input.idempotencyKey, "p3-rate-http-activate");
  assert.equal(netSuiteTransportCalls, 0);
});

test("rate-card editor reads named detail and updates an unused draft with optimistic revision", async () => {
  const detail = await request(`/api/mbt/config/rate-cards/${VERSION_ID}`, { actor: "admin" });
  assert.equal(detail.response.status, 200, JSON.stringify(detail.payload));
  assert.match(detail.response.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(detail.payload, RATE_DETAIL);

  const graph = {
    ...RATE_DETAIL.graph,
    components: [{ componentCode: "RENTAL_14YD", amount: "200.00" }]
  };
  const replaced = await request(`/api/mbt/config/rate-cards/${VERSION_ID}`, {
    actor: "admin",
    method: "PUT",
    body: {
      expectedRevision: 1,
      graph,
      reason: "Update the named business-rate editor"
    },
    idempotencyKey: "p3-rate-http-replace"
  });
  assert.equal(replaced.response.status, 200, JSON.stringify(replaced.payload));
  assert.equal(replaced.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.deepEqual(calls.map(({ method }) => method), ["detail", "replace"]);
  assert.equal(calls[0].input, VERSION_ID);
  assert.deepEqual(calls[1].input.actor, {
    operatorId: ACTORS.admin.id,
    roles: ["admin"]
  });
  assert.equal(calls[1].input.rateCardVersionId, VERSION_ID);
  assert.equal(calls[1].input.expectedRevision, 1);
  assert.equal(calls[1].input.sourceKind, "manual");
  assert.deepEqual(calls[1].input.graph, graph);
  assert.equal(calls[1].input.idempotencyKey, "p3-rate-http-replace");
  assert.equal(netSuiteTransportCalls, 0);
});

test("P3-F12 HTTP: a closed master-data gate preserves recovery reads and blocks all commands", async () => {
  capabilityAllowed = false;
  const read = await request("/api/mbt/config/rate-cards", { actor: "admin" });
  assert.equal(read.response.status, 200, JSON.stringify(read.payload));
  assert.equal(calls.filter(({ method }) => method === "list").length, 1);

  const commands = [
    {
      path: "/api/mbt/config/rate-cards",
      body: {
        sourceKind: "manual",
        graph: { rateCard: { rateCardCode: "BLOCKED" } },
        reason: "Must remain blocked"
      }
    },
    {
      path: `/api/mbt/config/rate-cards/${VERSION_ID}/validate`,
      body: { expectedRevision: 1, reason: "Must remain blocked" }
    },
    {
      path: `/api/mbt/config/rate-cards/${VERSION_ID}/activate`,
      body: { expectedRevision: 1, reason: "Must remain blocked" }
    }
  ];
  for (const [index, command] of commands.entries()) {
    const blocked = await request(command.path, {
      actor: "admin",
      method: "POST",
      body: command.body,
      idempotencyKey: `p3-rate-http-closed-${index}`
    });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.payload.code, "MBT_CAPABILITY_DISABLED");
    assert.match(blocked.response.headers.get("cache-control") || "", /no-store/);
  }
  assert.equal(calls.filter(({ method }) => method !== "list").length, 0);
  assert.equal(netSuiteTransportCalls, 0);
});
