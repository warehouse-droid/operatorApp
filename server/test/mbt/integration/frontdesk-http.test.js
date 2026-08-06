import assert from "node:assert/strict";
import express from "express";
import test, { after, before, beforeEach } from "node:test";

import { closeDb } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { createMbtRouter } from "../../../src/mbt/router.js";

const QUOTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTRACT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_LINE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACTORS = Object.freeze({
  frontdesk: Object.freeze({
    id: "p3-frontdesk-http-operator",
    role: "mbt_frontdesk",
    roles: Object.freeze(["mbt_frontdesk"]),
    homeRoute: "/mbt/frontdesk"
  }),
  dispatcher: Object.freeze({
    id: "p3-frontdesk-http-dispatcher",
    role: "dispatcher",
    roles: Object.freeze(["dispatcher"]),
    homeRoute: "/dispatch"
  })
});

let baseUrl;
let server;
let capabilityAllowed = true;
const calls = [];

/** @param {string} operation @param {Record<string, unknown>} input @param {number} [status] */
function commandResult(operation, input, status = 200) {
  calls.push({ operation, input });
  return {
    status,
    replayed: operation === "convert",
    body: { schemaVersion: `mbt-frontdesk-${operation}-http-v1`, operation }
  };
}

const frontdeskService = Object.freeze({
  async getFrontdeskConfiguration(input) {
    calls.push({ operation: "configuration", input });
    return { schemaVersion: "mbt-frontdesk-configuration-v1", binTypes: [], services: [] };
  },
  async searchFrontdeskCustomers(input) {
    calls.push({ operation: "customers", input });
    return { schemaVersion: "mbt-frontdesk-customers-v1", items: [] };
  },
  async getFrontdeskCustomerContracts(input) {
    calls.push({ operation: "customer-contracts", input });
    return {
      schemaVersion: "mbt-frontdesk-customer-contracts-v1",
      customerNetsuiteId: String(input.customerNetsuiteId),
      items: []
    };
  },
  async createFrontdeskQuote(input, pricing) {
    calls.push({ operation: "create", input, pricing });
    return {
      status: 201,
      replayed: false,
      body: { schemaVersion: "mbt-frontdesk-quote-http-v1", quoteId: QUOTE_ID }
    };
  },
  async issueFrontdeskQuote(input) {
    return commandResult("issue", input);
  },
  async acceptFrontdeskQuote(input) {
    return commandResult("accept", input);
  },
  async convertFrontdeskQuote(input) {
    return commandResult("convert", input, 201);
  },
  async getFrontdeskContractTimeline(input) {
    calls.push({ operation: "timeline", input });
    return { schemaVersion: "mbt-frontdesk-contract-v1", contractId: input.contractId };
  },
  async extendFrontdeskContract(input) {
    return commandResult("extend", input);
  },
  async extendFrontdeskServiceLine(input) {
    return commandResult("extend-line", input);
  },
  async exchangeFrontdeskServiceLine(input) {
    return commandResult("exchange-line", input);
  },
  async collectFrontdeskServiceLine(input) {
    return commandResult("collect-line", input);
  },
  async confirmFrontdeskServiceLineCustomerChange(input) {
    return commandResult("confirm-line-change", input);
  },
  async markFrontdeskServiceLineDispatchChange(input) {
    return commandResult("dispatch-change-request", input, 201);
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
  assert.equal(capability, "frontdeskOperations");
  if (!capabilityAllowed) {
    throw new MbtError({
      status: 409,
      code: "MBT_CAPABILITY_DISABLED",
      message: "This MBT capability is disabled."
    });
  }
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
  return {
    response,
    payload: await response.json().catch(() => ({}))
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(authenticate);
  app.use("/api/mbt", createMbtRouter({
    frontdeskService,
    frontdeskPricing: {
      resolveDistance: async () => ({ source: "server" }),
      resolveTaxPolicy: async () => ({ source: "server" })
    },
    authorizePhase3Capability,
    netSuiteTransport: async () => {
      throw new Error("Front Desk HTTP must remain local-only.");
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
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
  await closeDb();
});

test("P3-F13 HTTP: private reads are role-bound, no-store, and capability-gated", async () => {
  assert.equal((await request("/api/mbt/frontdesk/configuration")).response.status, 401);
  assert.equal((await request("/api/mbt/frontdesk/configuration", {
    actor: "dispatcher"
  })).response.status, 403);

  const configuration = await request("/api/mbt/frontdesk/configuration", { actor: "frontdesk" });
  assert.equal(configuration.response.status, 200);
  assert.match(configuration.response.headers.get("cache-control") || "", /no-store/);
  const customers = await request("/api/mbt/frontdesk/customers?query=Acme&limit=7", {
    actor: "frontdesk"
  });
  assert.equal(customers.response.status, 200);
  assert.deepEqual(calls.map(({ operation }) => operation), ["configuration", "customers"]);
  assert.deepEqual(calls[1].input, {
    actor: { operatorId: ACTORS.frontdesk.id, roles: ["mbt_frontdesk"] },
    query: "Acme",
    limit: 7
  });

  calls.length = 0;
  capabilityAllowed = false;
  const disabled = await request("/api/mbt/frontdesk/customers?query=Acme", {
    actor: "frontdesk"
  });
  assert.equal(disabled.response.status, 409);
  assert.equal(disabled.payload.code, "MBT_CAPABILITY_DISABLED");
  assert.equal(calls.length, 0);
});

test("P3-F13 HTTP: quote commands bind server actor, pricing adapters, and idempotency", async () => {
  const body = {
    actor: { operatorId: "forged-browser", roles: ["admin"] },
    customerNetsuiteId: "7143",
    siteProfileId: CONTRACT_ID,
    serviceTemplateVersionId: CONTRACT_ID,
    rateCardVersionId: CONTRACT_ID,
    binItemCode: "14YD",
    binTypeId: CONTRACT_ID,
    deliveryItemCode: "DELIVERY_CROSS_CHARGE",
    pricingOriginYardCode: "150",
    dumpItemCode: "SOIL",
    estimatedTonnes: "1.500",
    surcharges: [{ itemCode: "DOWNTOWN", amountMinor: 12500 }],
    serviceCode: "delivery",
    proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
    proposedReturnAt: "2037-08-17T12:00:00.000Z",
    reason: "Synthetic HTTP quote"
  };
  body.serviceLines = [{
    binItemCode: "14YD",
    binTypeId: CONTRACT_ID,
    dumpItemCode: "SOIL",
    estimatedTonnes: "1.500",
    proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
    proposedReturnAt: "2037-08-17T12:00:00.000Z"
  }, {
    binItemCode: "14YD",
    binTypeId: CONTRACT_ID,
    dumpItemCode: "CONCRETE",
    estimatedTonnes: "2.000",
    proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
    proposedReturnAt: "2037-08-17T12:00:00.000Z"
  }];
  const noKey = await request("/api/mbt/frontdesk/quotes", {
    actor: "frontdesk", method: "POST", body
  });
  assert.equal(noKey.response.status, 400);
  assert.equal(noKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");

  const created = await request("/api/mbt/frontdesk/quotes", {
    actor: "frontdesk",
    method: "POST",
    body,
    idempotencyKey: "p3-frontdesk-http-create"
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.match(created.response.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(calls[0].input.actor, {
    operatorId: ACTORS.frontdesk.id,
    roles: ["mbt_frontdesk"]
  });
  assert.equal(calls[0].input.idempotencyKey, "p3-frontdesk-http-create");
  assert.deepEqual(calls[0].input.serviceLines, body.serviceLines);
  assert.equal(calls[0].input.pricingOriginYardCode, "150");
  assert.equal(Object.hasOwn(calls[0].input, "clientDisplayTotals"), false);
  assert.equal(typeof calls[0].pricing.resolveDistance, "function");
  assert.equal(typeof calls[0].pricing.resolveTaxPolicy, "function");
});

test("MBT Front Desk HTTP: customer contracts and independent service-line actions are explicit", async () => {
  const contracts = await request("/api/mbt/frontdesk/customers/7143/contracts?limit=25", {
    actor: "frontdesk"
  });
  assert.equal(contracts.response.status, 200, JSON.stringify(contracts.payload));
  assert.deepEqual(contracts.payload, {
    schemaVersion: "mbt-frontdesk-customer-contracts-v1",
    customerNetsuiteId: "7143",
    items: []
  });
  assert.match(contracts.response.headers.get("cache-control") || "", /no-store/u);

  const common = {
    expectedRevision: 4,
    reason: "Customer-approved synthetic service change"
  };
  const actions = [
    ["extensions", {
      ...common,
      returnWindow: {
        startAt: "2037-09-01T12:00:00.000Z",
        endAt: "2037-09-01T16:00:00.000Z"
      }
    }, "extend-line"],
    ["exchanges", {
      ...common,
      exchangeWindow: {
        startAt: "2037-08-20T12:00:00.000Z",
        endAt: "2037-08-20T16:00:00.000Z"
      },
      incomingBinTypeId: QUOTE_ID,
      chargeMode: "free_internal",
      waiverReason: "Internal service recovery"
    }, "exchange-line"],
    ["collections", {
      ...common,
      collectionWindow: {
        startAt: "2037-08-24T12:00:00.000Z",
        endAt: "2037-08-24T16:00:00.000Z"
      }
    }, "collect-line"],
    ["customer-confirmations", {
      ...common,
      decision: "confirmed"
    }, "confirm-line-change"]
  ];
  for (const [route, body, operation] of actions) {
    const result = await request(
      `/api/mbt/frontdesk/contracts/${CONTRACT_ID}/service-lines/${SERVICE_LINE_ID}/${route}`,
      {
        actor: "frontdesk",
        method: "POST",
        body,
        idempotencyKey: `p3-frontdesk-http-${route}`
      }
    );
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.response.headers.get("x-mbt-idempotent-replay"), "false");
    const call = calls.find((candidate) => candidate.operation === operation);
    assert.ok(call, `${operation} must reach the service.`);
    assert.equal(call.input.contractId, CONTRACT_ID);
    assert.equal(call.input.serviceLineId, SERVICE_LINE_ID);
    assert.deepEqual(call.input.actor, {
      operatorId: ACTORS.frontdesk.id,
      roles: ["mbt_frontdesk"]
    });
    assert.equal(call.input.idempotencyKey, `p3-frontdesk-http-${route}`);
  }
});

test("MBT Dispatch HTTP: schedule or size edits create an audited customer-confirmation request", async () => {
  const path = `/api/mbt/dispatch/contracts/${CONTRACT_ID}/service-lines/${SERVICE_LINE_ID}/change-requests`;
  const body = {
    actor: { operatorId: "forged-front-end", roles: ["admin"] },
    expectedRevision: 6,
    change: {
      kind: "schedule",
      before: { startAt: "2037-08-03T12:00:00.000Z" },
      after: { startAt: "2037-08-04T12:00:00.000Z" }
    },
    reason: "Customer must confirm the Dispatch date change"
  };
  assert.equal((await request(path, {
    actor: "frontdesk",
    method: "POST",
    body,
    idempotencyKey: "frontdesk-must-not-use-dispatch-route"
  })).response.status, 403);

  const result = await request(path, {
    actor: "dispatcher",
    method: "POST",
    body,
    idempotencyKey: "p3-frontdesk-http-dispatch-change"
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.equal(result.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.match(result.response.headers.get("cache-control") || "", /no-store/u);
  const call = calls.find(({ operation }) => operation === "dispatch-change-request");
  assert.ok(call);
  assert.deepEqual(call.input.actor, {
    operatorId: ACTORS.dispatcher.id,
    roles: ["dispatcher"]
  });
  assert.equal(call.input.contractId, CONTRACT_ID);
  assert.equal(call.input.serviceLineId, SERVICE_LINE_ID);
  assert.equal(call.input.expectedRevision, 6);
  assert.deepEqual(call.input.change, body.change);
  assert.equal(call.input.reason, body.reason);
});

test("P3-F13/F14 HTTP: lifecycle and timeline routes preserve command identity", async () => {
  const commands = [
    ["issue", { expectedRevision: 1, validUntil: "2037-08-04T12:00:00.000Z" }],
    ["accept", { expectedRevision: 2, acceptedAt: "2037-08-03T10:00:00.000Z" }],
    ["convert", { expectedRevision: 3 }]
  ];
  for (const [action, body] of commands) {
    const result = await request(`/api/mbt/frontdesk/quotes/${QUOTE_ID}/${action}`, {
      actor: "frontdesk",
      method: "POST",
      body: { ...body, reason: `Synthetic ${action}` },
      idempotencyKey: `p3-frontdesk-http-${action}`
    });
    assert.equal(result.response.status, action === "convert" ? 201 : 200);
    assert.equal(result.response.headers.get("x-mbt-idempotent-replay"), String(action === "convert"));
  }

  const timeline = await request(`/api/mbt/frontdesk/contracts/${CONTRACT_ID}`, {
    actor: "frontdesk"
  });
  assert.equal(timeline.response.status, 200);
  const extension = await request(`/api/mbt/frontdesk/contracts/${CONTRACT_ID}/extensions`, {
    actor: "frontdesk",
    method: "POST",
    body: {
      expectedRevision: 1,
      returnWindow: {
        startAt: "2037-09-01T12:00:00.000Z",
        endAt: "2037-09-01T16:00:00.000Z"
      },
      reason: "Synthetic extension"
    },
    idempotencyKey: "p3-frontdesk-http-extension"
  });
  assert.equal(extension.response.status, 200);

  assert.deepEqual(calls.map(({ operation }) => operation), [
    "issue", "accept", "convert", "timeline", "extend"
  ]);
  for (const call of calls) {
    assert.deepEqual(call.input.actor, {
      operatorId: ACTORS.frontdesk.id,
      roles: ["mbt_frontdesk"]
    });
  }
  assert.equal(calls[0].input.quoteId, QUOTE_ID);
  assert.equal(calls[3].input.contractId, CONTRACT_ID);
  assert.equal(calls[4].input.idempotencyKey, "p3-frontdesk-http-extension");
});
