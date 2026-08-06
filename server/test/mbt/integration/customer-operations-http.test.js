import assert from "node:assert/strict";
import express from "express";
import test, { after, before, beforeEach } from "node:test";

import { closeDb } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { createMbtRouter } from "../../../src/mbt/router.js";

const ACTORS = Object.freeze({
  admin: Object.freeze({ id: "p3-customer-http-admin", role: "admin", roles: ["admin"], homeRoute: "/admin" }),
  frontdesk: Object.freeze({ id: "p3-customer-http-frontdesk", role: "mbt_frontdesk", roles: ["mbt_frontdesk"], homeRoute: "/mbt/frontdesk" }),
  operator: Object.freeze({ id: "p3-customer-http-operator", role: "operator", roles: ["operator"], homeRoute: "/operator" })
});

let baseUrl;
let server;
let capabilityAllowed = true;
const calls = [];

const customerOperationsService = Object.freeze({
  async startCustomerSync(input) {
    calls.push({ method: "sync", input });
    return { status: 202, replayed: false, body: { schemaVersion: "mbt-customer-sync-v1", runId: "run-1", status: "completed" } };
  },
  async listCustomerSyncRuns(input) {
    calls.push({ method: "runs", input });
    return { schemaVersion: "mbt-customer-sync-runs-v1", items: [], nextCursor: null };
  },
  async getCustomerSyncRun(runId) {
    calls.push({ method: "run", runId });
    return { schemaVersion: "mbt-customer-sync-run-v1", runId, status: "completed" };
  },
  async listCustomerConflicts(input) {
    calls.push({ method: "conflicts", input });
    return { schemaVersion: "mbt-customer-conflicts-v1", items: [], nextCursor: null };
  },
  async resolveCustomerConflict(input) {
    calls.push({ method: "resolve", input });
    return { status: 200, replayed: false, body: { schemaVersion: "mbt-customer-conflict-v1", status: "resolved" } };
  },
  async searchCustomers(input) {
    calls.push({ method: "search", input });
    return { schemaVersion: "mbt-customers-v1", items: [{ customerNetSuiteId: 900001, legalName: "Synthetic Customer" }], nextCursor: null };
  }
});

function authenticate(req, res, next) {
  const actor = ACTORS[String(req.get("authorization") || "").replace(/^Bearer\s+/i, "")];
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
    throw new MbtError({ status: 409, code: "MBT_CAPABILITY_DISABLED", message: "Customer sync is disabled." });
  }
}

async function request(path, { actor, method = "GET", body, key } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(actor ? { authorization: `Bearer ${actor}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(authenticate);
  app.use("/api/mbt", createMbtRouter({ customerOperationsService, authorizePhase3Capability }));
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
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await closeDb();
});

test("P3-F01 customer sync command is Admin-only, gated, idempotent, and server-actor-bound", async () => {
  assert.equal((await request("/api/mbt/customers/sync", { actor: "operator", method: "POST", body: {} })).response.status, 403);
  const noKey = await request("/api/mbt/customers/sync", { actor: "admin", method: "POST", body: { syncKind: "incremental" } });
  assert.equal(noKey.response.status, 400);
  assert.equal(noKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");

  const result = await request("/api/mbt/customers/sync", {
    actor: "admin",
    method: "POST",
    key: "p3-customer-http-sync",
    body: { actor: { operatorId: "forged" }, syncKind: "incremental", reason: "Synthetic sync" }
  });
  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  assert.match(result.response.headers.get("cache-control") || "", /no-store/);
  assert.equal(result.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.deepEqual(calls[0].input.actor, { operatorId: ACTORS.admin.id, roles: ["admin"] });
  assert.equal(calls[0].input.idempotencyKey, "p3-customer-http-sync");
  assert.equal(calls[0].input.syncKind, "incremental");

  capabilityAllowed = false;
  const blocked = await request("/api/mbt/customers/sync", {
    actor: "admin", method: "POST", key: "p3-customer-http-blocked", body: { syncKind: "incremental", reason: "Blocked" }
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(calls.filter(({ method }) => method === "sync").length, 1);
});

test("P3-F01/P3-F02 sync evidence and conflicts remain Admin-readable while the command gate is closed", async () => {
  capabilityAllowed = false;
  for (const path of [
    "/api/mbt/customers/sync/runs?limit=20",
    "/api/mbt/customers/sync/runs/run-1",
    "/api/mbt/customers/conflicts?status=open&limit=20"
  ]) {
    const result = await request(path, { actor: "admin" });
    assert.equal(result.response.status, 200, `${path}: ${JSON.stringify(result.payload)}`);
    assert.match(result.response.headers.get("cache-control") || "", /no-store/);
  }
});

test("P3-F02 conflict resolution requires Admin audit/revision/idempotency and binds the server actor", async () => {
  const body = { decision: "keep_current", expectedRevision: 1, reason: "Synthetic reviewed conflict" };
  const result = await request("/api/mbt/customers/conflicts/conflict-1/resolve", {
    actor: "admin", method: "POST", key: "p3-customer-http-resolve", body
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const call = calls.find(({ method }) => method === "resolve");
  assert.deepEqual(call.input.actor, { operatorId: ACTORS.admin.id, roles: ["admin"] });
  assert.equal(call.input.conflictId, "conflict-1");
  assert.equal(call.input.expectedRevision, 1);
  assert.equal(call.input.reason, body.reason);
});

test("P3-F05 canonical customer search is live-session Admin/Front-Desk read-only and paginated", async () => {
  assert.equal((await request("/api/mbt/customers/search?query=Synthetic", { actor: "operator" })).response.status, 403);
  const result = await request("/api/mbt/customers/search?query=Synthetic&limit=25", { actor: "frontdesk" });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.match(result.response.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(calls.at(-1), { method: "search", input: { query: "Synthetic", limit: 25, cursor: null } });
});
