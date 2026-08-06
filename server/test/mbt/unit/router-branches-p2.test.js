import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import express from "express";

import { createMbtRouter } from "../../../src/mbt/router.js";

const SAFE_RUNTIME = Object.freeze({
  accountId: "1234567_SB1",
  runtimeAccountId: "1234567_SB1",
  environmentName: "sandbox",
  restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
  sandboxAccountAllowlist: Object.freeze(["1234567_SB1"]),
  directAccessEnabled: true,
  readTimeoutMs: 1_000,
  preflightLeaseSeconds: 30
});

const OPERATORS = Object.freeze({
  admin_role: { id: "p2-router-admin-role", role: " ADMIN ", roles: "not-an-array" },
  admin_no_id: { role: "admin", roles: [] },
  billing_roles: { id: "p2-router-billing", role: null, roles: ["", "MBT BILLING"] },
  frontdesk_role: { id: "p2-router-frontdesk", role: "MBT-FRONTDESK", roles: [] },
  dispatcher: { id: "p2-router-dispatcher", role: "dispatcher", roles: null },
  admin: { id: "p2-router-admin", role: "admin", roles: ["admin"] }
});

let baseUrl;
let server;

function operatorFixture(req, _res, next) {
  const mode = String(req.get("x-test-operator") || "");
  if (OPERATORS[mode]) {
    req.operator = OPERATORS[mode];
  }
  if (req.get("x-test-cached-correlation")) {
    req.mbtCorrelationId = "cached-p2-correlation";
  }
  next();
}

async function request(path, {
  operator,
  method = "GET",
  body,
  headers = {}
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(operator ? { "x-test-operator": operator } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    response,
    payload: text ? JSON.parse(text) : null
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(operatorFixture);
  app.use("/api/mbt", createMbtRouter({
    netSuiteRuntime: SAFE_RUNTIME,
    async netSuiteTransport() {
      throw new Error("A validation-only router test must not reach NetSuite.");
    }
  }));
  app.use("/variant/mbt", createMbtRouter({
    netSuiteRuntime: {
      ...SAFE_RUNTIME,
      runtimeAccountId: "",
      restBaseUrl: `${SAFE_RUNTIME.restBaseUrl}/`,
      sandboxAccountAllowlist: "not-an-array"
    },
    async netSuiteTransport() {
      throw new Error("A validation-only router test must not reach NetSuite.");
    }
  }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("P2-F06 router normalizes primary, secondary, spaced, and hyphenated roles", async () => {
  const fixtures = [
    ["/api/mbt/frontdesk/status", "admin_role", "frontdesk"],
    ["/api/mbt/billing/status", "billing_roles", "billing"],
    ["/api/mbt/frontdesk/status", "frontdesk_role", "frontdesk"]
  ];
  for (const [path, operator, surface] of fixtures) {
    const result = await request(path, { operator });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.surface, surface);
  }

  for (const operator of [undefined, "dispatcher"]) {
    const denied = await request("/api/mbt/frontdesk/status", { operator });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.payload.redirect, "/");
  }
  const deniedAdmin = await request("/api/mbt/config/netsuite/mappings");
  assert.equal(deniedAdmin.response.status, 403);
  assert.equal(deniedAdmin.payload.redirect, "/");
  assert.match(deniedAdmin.response.headers.get("cache-control") || "", /no-store/);
});

test("P2-F02 router rejects absent actor, audit reason, and idempotency identity before persistence", async () => {
  const absentActor = await request("/api/mbt/config/netsuite/mappings", {
    operator: "admin_no_id",
    method: "PUT",
    body: {}
  });
  assert.equal(absentActor.response.status, 400);
  assert.equal(absentActor.payload.code, "MBT_OPERATOR_REQUIRED");

  const absentReason = await request("/api/mbt/config/netsuite/mappings", {
    operator: "admin",
    method: "PUT",
    body: {}
  });
  assert.equal(absentReason.response.status, 400);
  assert.equal(absentReason.payload.code, "MBT_AUDIT_REASON_REQUIRED");

  const absentIdentity = await request("/api/mbt/config/netsuite/mappings", {
    operator: "admin",
    method: "PUT",
    body: { reason: "Required identity boundary" }
  });
  assert.equal(absentIdentity.response.status, 400);
  assert.equal(absentIdentity.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");

  const absentNote = await request(
    "/api/mbt/config/netsuite/preflight/11111111-2222-4333-8444-555555555555/signoff",
    {
      operator: "admin",
      method: "POST",
      headers: { "idempotency-key": "p2-router-note" },
      body: {}
    }
  );
  assert.equal(absentNote.response.status, 400);
  assert.equal(absentNote.payload.code, "MBT_AUDIT_NOTE_REQUIRED");
});

test("P2-F02 router preserves bounded request identities and cached correlations on errors", async () => {
  const supplied = await request("/api/mbt/config/netsuite/mappings", {
    operator: "admin",
    method: "PUT",
    headers: {
      "idempotency-key": "p2-router-invalid-requirement",
      "x-correlation-id": "p2-supplied-correlation",
      "x-request-id": "p2-supplied-request"
    },
    body: {
      mappingType: "not_a_requirement",
      localKey: "not_a_requirement",
      mapping: {},
      expectedRevision: 0,
      reason: "Reject an unknown server-owned requirement"
    }
  });
  assert.equal(supplied.response.status, 404);
  assert.equal(supplied.payload.code, "MBT_NETSUITE_MAPPING_REQUIREMENT_NOT_FOUND");
  assert.equal(supplied.payload.correlationId, "p2-supplied-correlation");

  const overlong = "x".repeat(161);
  const generated = await request("/api/mbt/config/netsuite/mappings", {
    operator: "admin",
    method: "PUT",
    headers: {
      "idempotency-key": "p2-router-invalid-generated",
      "x-correlation-id": overlong,
      "x-request-id": overlong
    },
    body: {
      mappingType: "still_not_a_requirement",
      localKey: "still_not_a_requirement",
      mapping: {},
      expectedRevision: 0,
      reason: "Generate bounded request identities"
    }
  });
  assert.equal(generated.response.status, 404);
  assert.match(generated.payload.correlationId, /^[0-9a-f-]{36}$/i);

  const cached = await request("/api/mbt/bin-assets/asset/reservations", {
    method: "POST",
    headers: { "x-test-cached-correlation": "1" }
  });
  assert.equal(cached.response.status, 409);
  assert.equal(cached.payload.code, "MBT_CAPABILITY_DISABLED");
  assert.equal(cached.payload.correlationId, "cached-p2-correlation");
});

test("P2-F04 router normalizes alternate runtime shapes before rejecting malformed run IDs", async () => {
  const result = await request("/variant/mbt/config/netsuite/preflight/not-a-uuid", {
    operator: "admin"
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.code, "MBT_NETSUITE_PREFLIGHT_RUN_INVALID");
  assert.match(result.response.headers.get("cache-control") || "", /no-store/);
});
