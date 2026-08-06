import assert from "node:assert/strict";
import express from "express";
import test, { after, before, beforeEach } from "node:test";

import { closeDb } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { createMbtRouter } from "../../../src/mbt/router.js";

const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MOVEMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTORS = Object.freeze({
  admin: Object.freeze({
    id: "p3-asset-http-admin",
    role: "admin",
    roles: Object.freeze(["admin"]),
    homeRoute: "/admin"
  }),
  dispatcher: Object.freeze({
    id: "p3-asset-http-dispatcher",
    role: "dispatcher",
    roles: Object.freeze(["dispatcher"]),
    homeRoute: "/dispatch"
  }),
  operator: Object.freeze({
    id: "p3-asset-http-operator",
    role: "operator",
    roles: Object.freeze(["operator"]),
    homeRoute: "/operator"
  })
});
const PUBLIC_ASSET = Object.freeze({
  assetId: ASSET_ID,
  assetCode: "P3-HTTP-BIN-001",
  qrCode: "P3-HTTP-QR-001",
  barcode: "P3-HTTP-BAR-001",
  binTypeId: "00000000-0000-4000-8000-000000000014",
  homeYardId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  active: true,
  underMaintenance: false,
  revision: 1,
  currentState: Object.freeze({
    lifecycleStatus: "available",
    locationKind: "yard",
    locationReference: "12441",
    lastMovementId: MOVEMENT_ID,
    revision: 1
  })
});

let baseUrl;
let server;
let capabilityAllowed = true;
let netSuiteTransportCalls = 0;
const calls = [];

const assetRegistryService = Object.freeze({
  async getMbtAssetOpeningOptions() {
    calls.push({ method: "opening-options" });
    return {
      schemaVersion: "mbt-asset-opening-options-v1",
      binTypes: [{
        binTypeId: "00000000-0000-4000-8000-000000000014",
        typeCode: "14YD",
        displayName: "14 yard bin"
      }],
      yards: [{
        yardId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        yardCode: "12441",
        yardName: "Woodbine yard"
      }]
    };
  },
  async listMbtBinAssets(input) {
    calls.push({ method: "list", input });
    return {
      schemaVersion: "mbt-assets-v1",
      items: [PUBLIC_ASSET],
      nextCursor: null
    };
  },
  async registerMbtBinAsset(input) {
    calls.push({ method: "register", input });
    return {
      status: 201,
      replayed: false,
      body: { schemaVersion: "mbt-asset-v1", asset: PUBLIC_ASSET }
    };
  },
  async getMbtBinAssetTimeline(assetId) {
    calls.push({ method: "timeline", assetId });
    return {
      schemaVersion: "mbt-asset-timeline-v1",
      assetId,
      movements: [{
        movementId: MOVEMENT_ID,
        assetSequence: 1,
        movementType: "asset_registered"
      }]
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
  assert.equal(capability, "assetManagement");
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
    assetRegistryService,
    authorizePhase3Capability,
    netSuiteTransport: async () => {
      netSuiteTransportCalls += 1;
      throw new Error("Asset registry APIs must remain local-only.");
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

test("P3-F11 HTTP: live Admin and Dispatcher may read private registry/timeline evidence", async () => {
  const anonymous = await request("/api/mbt/assets");
  assert.equal(anonymous.response.status, 401);

  const operator = await request("/api/mbt/assets", { actor: "operator" });
  assert.equal(operator.response.status, 403);
  assert.match(operator.response.headers.get("cache-control") || "", /no-store/);

  const dispatcher = await request("/api/mbt/assets?query=P3-HTTP&limit=20", {
    actor: "dispatcher"
  });
  assert.equal(dispatcher.response.status, 200, JSON.stringify(dispatcher.payload));
  assert.match(dispatcher.response.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(dispatcher.payload, {
    schemaVersion: "mbt-assets-v1",
    items: [PUBLIC_ASSET],
    nextCursor: null
  });

  const timeline = await request(`/api/mbt/assets/${ASSET_ID}/timeline`, {
    actor: "admin"
  });
  assert.equal(timeline.response.status, 200, JSON.stringify(timeline.payload));
  assert.match(timeline.response.headers.get("cache-control") || "", /no-store/);
  assert.equal(timeline.payload.movements[0].movementType, "asset_registered");

  assert.deepEqual(calls, [
    {
      method: "list",
      input: { query: "P3-HTTP", limit: 20, cursor: null }
    },
    { method: "timeline", assetId: ASSET_ID }
  ]);
  assert.equal(netSuiteTransportCalls, 0);
});

test("MBT assets HTTP: named opening options are authenticated, role-limited, and never cached", async () => {
  const anonymous = await request("/api/mbt/assets/opening-options");
  assert.equal(anonymous.response.status, 401);

  const operator = await request("/api/mbt/assets/opening-options", { actor: "operator" });
  assert.equal(operator.response.status, 403);

  for (const actor of ["dispatcher", "admin"]) {
    calls.length = 0;
    const result = await request("/api/mbt/assets/opening-options", { actor });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.match(result.response.headers.get("cache-control") || "", /no-store/u);
    assert.deepEqual(result.payload, {
      schemaVersion: "mbt-asset-opening-options-v1",
      binTypes: [{
        binTypeId: "00000000-0000-4000-8000-000000000014",
        typeCode: "14YD",
        displayName: "14 yard bin"
      }],
      yards: [{
        yardId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        yardCode: "12441",
        yardName: "Woodbine yard"
      }]
    });
    assert.deepEqual(calls, [{ method: "opening-options" }]);
  }
  assert.equal(netSuiteTransportCalls, 0);
});

test("P3-F11 HTTP: registration is Admin-only, gated, idempotent, and binds the server actor", async () => {
  const body = {
    actor: { operatorId: "browser-forgery", roles: ["admin"] },
    asset: {
      assetCode: PUBLIC_ASSET.assetCode,
      qrCode: PUBLIC_ASSET.qrCode,
      barcode: PUBLIC_ASSET.barcode,
      binTypeId: PUBLIC_ASSET.binTypeId,
      homeYardId: PUBLIC_ASSET.homeYardId,
      active: true,
      underMaintenance: false
    },
    initialState: {
      lifecycleStatus: "available",
      location: {
        kind: "yard",
        reference: "12441",
        yardId: PUBLIC_ASSET.homeYardId
      },
      occurredAt: "2036-08-03T12:34:56.000Z"
    },
    reason: "Register synthetic HTTP asset"
  };
  const dispatcher = await request("/api/mbt/assets", {
    actor: "dispatcher",
    method: "POST",
    body,
    idempotencyKey: "p3-http-dispatcher-forbidden"
  });
  assert.equal(dispatcher.response.status, 403);

  const withoutKey = await request("/api/mbt/assets", {
    actor: "admin",
    method: "POST",
    body
  });
  assert.equal(withoutKey.response.status, 400);
  assert.equal(withoutKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");
  assert.match(withoutKey.response.headers.get("cache-control") || "", /no-store/);

  const created = await request("/api/mbt/assets", {
    actor: "admin",
    method: "POST",
    body,
    idempotencyKey: "p3-http-register"
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.match(created.response.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(created.payload, { schemaVersion: "mbt-asset-v1", asset: PUBLIC_ASSET });

  const call = calls.find(({ method }) => method === "register");
  assert.ok(call);
  assert.deepEqual(call.input.actor, {
    operatorId: ACTORS.admin.id,
    roles: ["admin"]
  });
  assert.deepEqual(call.input.asset, body.asset);
  assert.deepEqual(call.input.initialState, body.initialState);
  assert.equal(call.input.reason, body.reason);
  assert.equal(call.input.idempotencyKey, "p3-http-register");
  assert.equal(Object.hasOwn(call.input, "role"), false);
  assert.equal(netSuiteTransportCalls, 0);
});

test("P3-F11 HTTP: closing the asset gate blocks new commands but preserves authorized recovery reads", async () => {
  capabilityAllowed = false;
  const read = await request("/api/mbt/assets", { actor: "dispatcher" });
  assert.equal(read.response.status, 200, JSON.stringify(read.payload));
  assert.equal(calls.filter(({ method }) => method === "list").length, 1);

  const blocked = await request("/api/mbt/assets", {
    actor: "admin",
    method: "POST",
    idempotencyKey: "p3-http-closed-gate",
    body: {
      asset: {
        assetCode: PUBLIC_ASSET.assetCode,
        binTypeId: PUBLIC_ASSET.binTypeId,
        homeYardId: PUBLIC_ASSET.homeYardId
      },
      initialState: {
        lifecycleStatus: "available",
        location: {
          kind: "yard",
          reference: "12441",
          yardId: PUBLIC_ASSET.homeYardId
        },
        occurredAt: "2036-08-03T12:34:56.000Z"
      },
      reason: "Must remain blocked"
    }
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.payload.code, "MBT_CAPABILITY_DISABLED");
  assert.match(blocked.response.headers.get("cache-control") || "", /no-store/);
  assert.equal(calls.filter(({ method }) => method === "register").length, 0);
  assert.equal(netSuiteTransportCalls, 0);
});
