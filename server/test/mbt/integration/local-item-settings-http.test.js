import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import express from "express";

import { beginRollbackContext, closeDb } from "../../../src/db.js";
import { createMbtRouter } from "../../../src/mbt/router.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const ACTORS = Object.freeze({
  admin: {
    id: `local-http-admin-${RUN_ID}`,
    role: "admin",
    roles: ["admin"],
    homeRoute: "/admin"
  },
  dispatcher: {
    id: `local-http-dispatcher-${RUN_ID}`,
    role: "dispatcher",
    roles: ["dispatcher"],
    homeRoute: "/dispatch"
  }
});
let baseUrl;
let rollbackContext;
let server;
let netSuiteTransportCalls = 0;

function authenticate(req, res, next) {
  const token = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const actor = ACTORS[token];
  if (!actor) {
    return res.status(401).json({ error: "Login required" });
  }
  req.operator = actor;
  return next();
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
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

before(async () => {
  rollbackContext = await beginRollbackContext();
  await rollbackContext.run(async () => {
    const app = express();
    app.use(express.json());
    app.use(authenticate);
    app.use("/api/mbt", createMbtRouter({
      netSuiteTransport: async () => {
        netSuiteTransportCalls += 1;
        throw new Error("Local item APIs must not contact NetSuite.");
      },
      netSuiteRuntime: {
        accountId: "",
        runtimeAccountId: "",
        environmentName: "production",
        restBaseUrl: "",
        sandboxAccountAllowlist: [],
        directAccessEnabled: false,
        readTimeoutMs: 10_000,
        preflightLeaseSeconds: 120
      }
    }));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
  await rollbackContext?.rollback();
  await closeDb();
});

test("LC07/LC09: local item reads are Admin-only, no-store, bounded, and externally quiet", async () => {
  const anonymous = await request("/api/mbt/config/local/items");
  assert.equal(anonymous.response.status, 401);

  const dispatcher = await request("/api/mbt/config/local/items", { actor: "dispatcher" });
  assert.equal(dispatcher.response.status, 403);

  const admin = await request("/api/mbt/config/local/items", { actor: "admin" });
  assert.equal(admin.response.status, 200);
  assert.match(admin.response.headers.get("cache-control") || "", /no-store/);
  assert.equal(admin.payload.schemaVersion, "mbt-local-items-v1");
  assert.deepEqual(admin.payload.items.filter(({ systemOwned }) => systemOwned).map(({ itemCode }) => itemCode), [
    "DELIVERY_CROSS_CHARGE",
    "14YD",
    "20YD",
    "40YD",
    "DUMP"
  ]);
  assert.ok(admin.payload.items.every((item) => (
    !Object.hasOwn(item, "defaultUnitAmountMinor")
      && !Object.hasOwn(item, "unitOfMeasure")
      && !Object.hasOwn(item, "netSuiteItemId")
  )));
  assert.equal(netSuiteTransportCalls, 0);
});

test("LC05/LC06/LC07: Admin updates require audit identity and replay exactly once", async () => {
  const listed = await request("/api/mbt/config/local/items", { actor: "admin" });
  const item = listed.payload.items.find(({ itemCode }) => itemCode === "DUMP");
  assert.ok(item);
  const body = {
    displayName: `Local dump ${RUN_ID}`,
    description: "Custom price is entered on each local order.",
    active: true,
    expectedRevision: item.revision,
    reason: "Confirm local-only dump behavior"
  };
  const key = `local-http-${RUN_ID}`;

  const noKey = await request("/api/mbt/config/local/items/DUMP", {
    actor: "admin",
    method: "PUT",
    body
  });
  assert.equal(noKey.response.status, 400);
  assert.equal(noKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");

  const first = await request("/api/mbt/config/local/items/DUMP", {
    actor: "admin",
    method: "PUT",
    body,
    idempotencyKey: key
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.equal(first.payload.item.displayName, body.displayName);
  assert.equal(first.payload.item.revision, item.revision + 1);
  assert.equal(first.payload.item.itemType, "dump");
  assert.equal(first.payload.item.priceMode, "rate_card");
  assert.equal(first.payload.item.netSuite, null);

  const replay = await request("/api/mbt/config/local/items/DUMP", {
    actor: "admin",
    method: "PUT",
    body,
    idempotencyKey: key
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.response.headers.get("x-mbt-idempotent-replay"), "true");
  assert.deepEqual(replay.payload, first.payload);
  assert.equal(netSuiteTransportCalls, 0);
});

test("LC04/LC07: hostile API fields and unknown local codes fail closed", async () => {
  const dispatcher = await request("/api/mbt/config/local/items/14YD", {
    actor: "dispatcher",
    method: "PUT",
    idempotencyKey: `dispatcher-${RUN_ID}`,
    body: {
      displayName: "Forbidden",
      description: "",
      active: true,
      expectedRevision: 1,
      reason: "Must not save"
    }
  });
  assert.equal(dispatcher.response.status, 403);

  const hostile = await request("/api/mbt/config/local/items/14YD", {
    actor: "admin",
    method: "PUT",
    idempotencyKey: `hostile-${RUN_ID}`,
    body: {
      displayName: "Hostile",
      description: "",
      active: true,
      expectedRevision: 1,
      reason: "Must reject pricing drift",
      defaultUnitAmountMinor: 1,
      netSuiteItemId: 3637
    }
  });
  assert.equal(hostile.response.status, 400);
  assert.equal(hostile.payload.code, "MBT_LOCAL_ITEM_INPUT_INVALID");

  const missing = await request("/api/mbt/config/local/items/UNKNOWN", {
    actor: "admin",
    method: "PUT",
    idempotencyKey: `missing-${RUN_ID}`,
    body: {
      displayName: "Unknown",
      description: "",
      active: true,
      expectedRevision: 1,
      reason: "Unknown target"
    }
  });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload.code, "MBT_LOCAL_ITEM_NOT_FOUND");
  assert.equal(netSuiteTransportCalls, 0);
});
