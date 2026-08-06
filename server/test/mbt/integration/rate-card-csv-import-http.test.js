// @ts-check

import assert from "node:assert/strict";
import express from "express";
import test, { after, before } from "node:test";

import { closeDb } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { createMbtRouter } from "../../../src/mbt/router.js";
import { buildRateCardCsvFiles } from "../support/rate-card-csv-import-fixtures.js";

const BATCH_ID = "33333333-3333-4333-8333-333333333336";
const NORMALIZED_HASH = "a".repeat(64);
const TARGET_TOKEN = "b".repeat(64);
const VERSION_ID = "44444444-4444-4444-8444-444444444446";
const ACTORS = Object.freeze({
  admin: Object.freeze({ id: "p36-csv-http-admin", role: "admin", roles: Object.freeze(["admin"]), homeRoute: "/admin" }),
  dispatcher: Object.freeze({ id: "p36-csv-http-dispatch", role: "dispatcher", roles: Object.freeze(["dispatcher"]), homeRoute: "/dispatch" })
});
const PREVIEW = Object.freeze({
  schemaVersion: "mbt-rate-card-import-preview-v1",
  batchId: BATCH_ID,
  status: "previewed",
  fileHash: "c".repeat(64),
  normalizedHash: NORMALIZED_HASH,
  targetRevisionToken: TARGET_TOKEN,
  summary: Object.freeze({ fileCount: 5, totalRows: 3 }),
  graph: Object.freeze({ rateCard: Object.freeze({ rateCardCode: "P36CSV_HTTP" }) })
});
const APPLY = Object.freeze({
  schemaVersion: "mbt-rate-card-import-apply-v1",
  batchId: BATCH_ID,
  status: "applied",
  normalizedHash: NORMALIZED_HASH,
  version: Object.freeze({ rateCardVersionId: VERSION_ID, status: "draft", revision: 1 })
});

const calls = [];
let capabilityAllowed = true;
let server;
let baseUrl;

const rateCardImportService = Object.freeze({
  async previewRateCardCsvImport(input) {
    calls.push({ method: "preview", input });
    return PREVIEW;
  },
  async applyRateCardCsvImport(input) {
    calls.push({ method: "apply", input });
    return { status: 201, body: APPLY, replayed: false };
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

async function authorizePhase3Capability({ capability }) {
  assert.equal(capability, "masterData");
  if (!capabilityAllowed) {
    throw new MbtError({ status: 409, code: "MBT_CAPABILITY_DISABLED", message: "Disabled" });
  }
}

async function request(path, { actor, body, headers = {}, method = "GET" } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(actor ? { authorization: `Bearer ${actor}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use(authenticate);
  app.use("/api/mbt", createMbtRouter({ rateCardImportService, authorizePhase3Capability }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await closeDb();
});

test("P3-F12 CSV HTTP: preview is live-session Admin/master-data only before service access", async () => {
  const files = buildRateCardCsvFiles({ suffix: "HTTP", minimal: true });
  const anonymous = await request("/api/mbt/config/rate-card-imports/preview", {
    method: "POST",
    body: { files }
  });
  assert.equal(anonymous.response.status, 401);

  const dispatcher = await request("/api/mbt/config/rate-card-imports/preview", {
    actor: "dispatcher",
    method: "POST",
    headers: { "x-mbbs-role": "admin" },
    body: { files }
  });
  assert.equal(dispatcher.response.status, 403);
  assert.match(dispatcher.response.headers.get("cache-control") || "", /no-store/u);

  capabilityAllowed = false;
  try {
    const disabled = await request("/api/mbt/config/rate-card-imports/preview", {
      actor: "admin",
      method: "POST",
      body: { files }
    });
    assert.equal(disabled.response.status, 409);
    assert.equal(disabled.payload.code, "MBT_CAPABILITY_DISABLED");
  } finally {
    capabilityAllowed = true;
  }
  assert.equal(calls.length, 0);
});

test("P3-F12 CSV HTTP: preview sends the exact five raw texts to a server-owned actor and is no-store", async () => {
  const files = buildRateCardCsvFiles({ suffix: "HTTP", minimal: true });
  const result = await request("/api/mbt/config/rate-card-imports/preview", {
    actor: "admin",
    method: "POST",
    body: { files }
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.match(result.response.headers.get("cache-control") || "", /no-store/u);
  assert.deepEqual(result.payload, PREVIEW);
  const call = calls.find(({ method }) => method === "preview");
  assert.ok(call);
  assert.deepEqual(call.input.actor, { operatorId: ACTORS.admin.id, roles: ["admin"] });
  assert.deepEqual(call.input.files, files);
  assert.equal(Object.hasOwn(call.input, "role"), false);
});

test("P3-F12 CSV HTTP: apply requires idempotency and forwards only preview identities plus audit reason", async () => {
  const body = {
    batchId: BATCH_ID,
    normalizedHash: NORMALIZED_HASH,
    targetRevisionToken: TARGET_TOKEN,
    reason: "Approve HTTP five-file preview"
  };
  const missingKey = await request("/api/mbt/config/rate-card-imports/apply", {
    actor: "admin",
    method: "POST",
    body
  });
  assert.equal(missingKey.response.status, 400);
  assert.equal(missingKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");

  const applied = await request("/api/mbt/config/rate-card-imports/apply", {
    actor: "admin",
    method: "POST",
    headers: { "idempotency-key": "p36-csv-http-apply" },
    body
  });
  assert.equal(applied.response.status, 201);
  assert.match(applied.response.headers.get("cache-control") || "", /no-store/u);
  assert.equal(applied.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.deepEqual(applied.payload, APPLY);
  const call = calls.find(({ method }) => method === "apply");
  assert.ok(call);
  assert.deepEqual(call.input.actor, { operatorId: ACTORS.admin.id, roles: ["admin"] });
  assert.equal(call.input.batchId, BATCH_ID);
  assert.equal(call.input.normalizedHash, NORMALIZED_HASH);
  assert.equal(call.input.targetRevisionToken, TARGET_TOKEN);
  assert.equal(call.input.reason, body.reason);
  assert.equal(call.input.idempotencyKey, "p36-csv-http-apply");
});
