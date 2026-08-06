// @ts-check

import assert from "node:assert/strict";
import express from "express";
import test, { after, before, beforeEach } from "node:test";

import { closeDb } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { createMbtRouter } from "../../../src/mbt/router.js";
import { buildAssetCsvFile } from "../support/asset-csv-import-fixtures.js";

const BATCH_ID = "35353535-3535-4353-8353-353535353535";
const NORMALIZED_HASH = "a".repeat(64);
const TARGET_REVISION_HASH = "b".repeat(64);
const ACTORS = Object.freeze({
  admin: Object.freeze({ id: "p35-csv-http-admin", role: "admin", roles: Object.freeze(["admin"]), homeRoute: "/admin" }),
  dispatcher: Object.freeze({ id: "p35-csv-http-dispatcher", role: "dispatcher", roles: Object.freeze(["dispatcher"]), homeRoute: "/dispatch" })
});
const TEMPLATE = Object.freeze({
  schemaVersion: "mbt-bin-assets-csv-v1",
  fileName: "mbt-bin-assets-v1.csv",
  content: "asset_code,qr_code\r\n"
});
const PREVIEW = Object.freeze({
  schemaVersion: "mbt-bin-assets-import-preview-v1",
  batchId: BATCH_ID,
  status: "previewed",
  fileHash: "c".repeat(64),
  normalizedHash: NORMALIZED_HASH,
  targetRevisionToken: TARGET_REVISION_HASH,
  summary: Object.freeze({ rowCount: 1 }),
  rows: Object.freeze([{ rowNumber: 2, assetCode: "P35CSV-HTTP-1" }])
});
const APPLY = Object.freeze({
  schemaVersion: "mbt-bin-assets-import-apply-v1",
  batchId: BATCH_ID,
  status: "applied",
  normalizedHash: NORMALIZED_HASH,
  summary: Object.freeze({ created: 1 }),
  items: Object.freeze([{ rowNumber: 2, assetId: "35353535-3535-4353-8353-353535353536", assetCode: "P35CSV-HTTP-1", revision: 1 }])
});

const calls = [];
let capabilityAllowed = true;
let server;
let baseUrl;

const assetCsvImportService = Object.freeze({
  getMbtBinAssetCsvTemplate() {
    calls.push({ method: "template" });
    return TEMPLATE;
  },
  async previewMbtBinAssetCsvImport(input) {
    calls.push({ method: "preview", input });
    return PREVIEW;
  },
  async applyMbtBinAssetCsvImport(input) {
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
  assert.equal(capability, "assetManagement");
  if (!capabilityAllowed) {
    throw new MbtError({ status: 409, code: "MBT_CAPABILITY_DISABLED", message: "Disabled" });
  }
}

/** @param {string} path @param {{actor?: string, method?: string, body?: any, headers?: Record<string, string>}} [options] */
async function request(path, { actor, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(actor ? { authorization: `Bearer ${actor}` } : {}),
      ...headers
    },
    body
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json")
    ? await response.json().catch(() => ({}))
    : await response.text();
  return { response, payload };
}

before(async () => {
  const app = express();
  app.use(authenticate);
  app.use(express.json({ limit: "25mb" }));
  app.use("/api/mbt", createMbtRouter({
    assetCsvImportService,
    authorizePhase3Capability
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
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await closeDb();
});

test("P3-F11 CSV HTTP: template is authenticated Admin/asset-gated, no-store, and downloadable", async () => {
  const anonymous = await request("/api/mbt/assets/import/template");
  assert.equal(anonymous.response.status, 401);
  const dispatcher = await request("/api/mbt/assets/import/template", { actor: "dispatcher" });
  assert.equal(dispatcher.response.status, 403);
  assert.match(dispatcher.response.headers.get("cache-control") || "", /no-store/u);

  capabilityAllowed = false;
  const disabled = await request("/api/mbt/assets/import/template", { actor: "admin" });
  assert.equal(disabled.response.status, 409);
  assert.equal(disabled.payload.code, "MBT_CAPABILITY_DISABLED");
  assert.equal(calls.length, 0);

  capabilityAllowed = true;
  const downloaded = await request("/api/mbt/assets/import/template", { actor: "admin" });
  assert.equal(downloaded.response.status, 200);
  assert.match(downloaded.response.headers.get("cache-control") || "", /no-store/u);
  assert.match(downloaded.response.headers.get("content-type") || "", /text\/csv/u);
  assert.match(downloaded.response.headers.get("content-disposition") || "", /mbt-bin-assets-v1\.csv/u);
  assert.equal(downloaded.payload, TEMPLATE.content);
  assert.deepEqual(calls, [{ method: "template" }]);
});

test("P3-F11 CSV HTTP: preview authorizes before raw parsing and binds exact bytes to the server actor", async () => {
  const file = buildAssetCsvFile({ suffix: "HTTP" });
  capabilityAllowed = false;
  const disabled = await request("/api/mbt/assets/import/preview", {
    actor: "admin",
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "x-mbt-source-filename": file.fileName
    },
    body: file.content
  });
  assert.equal(disabled.response.status, 409);
  assert.equal(calls.length, 0);

  capabilityAllowed = true;
  const previewed = await request("/api/mbt/assets/import/preview", {
    actor: "admin",
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "x-mbt-source-filename": file.fileName,
      "x-mbbs-role": "dispatcher"
    },
    body: file.content
  });
  assert.equal(previewed.response.status, 201, JSON.stringify(previewed.payload));
  assert.match(previewed.response.headers.get("cache-control") || "", /no-store/u);
  assert.deepEqual(previewed.payload, PREVIEW);
  const call = calls.find(({ method }) => method === "preview");
  assert.ok(call);
  assert.deepEqual(call.input.actor, { operatorId: ACTORS.admin.id, roles: ["admin"] });
  assert.equal(Buffer.isBuffer(call.input.content), true);
  assert.equal(call.input.content.toString("utf8"), file.content);
  assert.equal(call.input.fileName, file.fileName);
});

test("P3-F11 CSV HTTP: apply requires Admin, gate, idempotency, preview identities, and no-store replay evidence", async () => {
  const body = {
    actor: { operatorId: "browser-forgery", roles: ["admin"] },
    normalizedHash: NORMALIZED_HASH,
    targetRevisionToken: TARGET_REVISION_HASH,
    reason: "Approve synthetic asset preview"
  };
  const missingKey = await request(`/api/mbt/assets/import/${BATCH_ID}/apply`, {
    actor: "admin",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(missingKey.response.status, 400);
  assert.equal(missingKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");

  const applied = await request(`/api/mbt/assets/import/${BATCH_ID}/apply`, {
    actor: "admin",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "p35-csv-http-apply"
    },
    body: JSON.stringify(body)
  });
  assert.equal(applied.response.status, 201, JSON.stringify(applied.payload));
  assert.match(applied.response.headers.get("cache-control") || "", /no-store/u);
  assert.equal(applied.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.deepEqual(applied.payload, APPLY);
  const call = calls.find(({ method }) => method === "apply");
  assert.ok(call);
  assert.deepEqual(call.input.actor, { operatorId: ACTORS.admin.id, roles: ["admin"] });
  assert.equal(call.input.batchId, BATCH_ID);
  assert.equal(call.input.normalizedHash, NORMALIZED_HASH);
  assert.equal(call.input.targetRevisionToken, TARGET_REVISION_HASH);
  assert.equal(call.input.reason, body.reason);
  assert.equal(call.input.idempotencyKey, "p35-csv-http-apply");
});
