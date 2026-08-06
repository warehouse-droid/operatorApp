import assert from "node:assert/strict";
import express from "express";
import test, { after, before } from "node:test";

import { closeDb } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { createMbtRouter } from "../../../src/mbt/router.js";
import {
  buildCustomerSpreadsheetMl,
  CUSTOMER_IMPORT_DEFAULTS,
  syntheticCustomerRow
} from "../support/master-data-import-fixtures.js";

const BATCH_ID = "33333333-3333-4333-8333-333333333333";
const NORMALIZED_HASH = "a".repeat(64);
const FILE_HASH = "b".repeat(64);
const REVISION_TOKEN = "c".repeat(64);
const ACTORS = Object.freeze({
  admin: Object.freeze({
    id: "p3-import-http-admin",
    role: "admin",
    roles: Object.freeze(["admin"]),
    homeRoute: "/admin"
  }),
  dispatcher: Object.freeze({
    id: "p3-import-http-dispatcher",
    role: "dispatcher",
    roles: Object.freeze(["dispatcher"]),
    homeRoute: "/dispatch"
  })
});
const PUBLIC_PREVIEW = Object.freeze({
  schemaVersion: "mbt-import-preview-v1",
  batchId: BATCH_ID,
  resource: "customers",
  sourceKind: "netsuite_spreadsheetml",
  status: "previewed",
  fileHash: FILE_HASH,
  normalizedHash: NORMALIZED_HASH,
  targetRevisionToken: REVISION_TOKEN,
  summary: Object.freeze({
    totalRows: 1,
    validRows: 1,
    invalidRows: 0,
    skippedRows: 0,
    createdCandidates: 1,
    updatedCandidates: 0,
    unchangedCandidates: 0,
    conflictedCandidates: 0
  }),
  warnings: Object.freeze([]),
  errors: Object.freeze([])
});
const APPLY_BODY = Object.freeze({
  schemaVersion: "mbt-import-apply-v1",
  batchId: BATCH_ID,
  resource: "customers",
  normalizedHash: NORMALIZED_HASH,
  status: "applied",
  counts: Object.freeze({ created: 1, updated: 0, unchanged: 0, conflicted: 0 }),
  entityIds: Object.freeze(["940001"])
});

let baseUrl;
let server;
let capabilityAllowed = true;
const calls = [];
const capabilityCalls = [];

const importService = Object.freeze({
  async getTemplate(input) {
    calls.push({ method: "template", input });
    const local = input.resource === "materials";
    return {
      status: 200,
      body: local
        ? "material_code,display_name,description,active,expected_revision\r\n"
        : "customer_internal_id,entity_name,legal_name,display_name,active,currency,source_modified_at,source_version,account_id\r\n",
      contentType: "text/csv; charset=utf-8",
      filename: `${input.resource}-v1.csv`
    };
  },
  async previewMasterDataImport(input) {
    calls.push({ method: "preview", input });
    return { ...PUBLIC_PREVIEW, resource: input.resource, sourceKind: input.sourceKind };
  },
  async applyMasterDataImport(input) {
    calls.push({ method: "apply", input });
    return { status: 201, body: APPLY_BODY, replayed: false };
  },
  async getMasterDataImportBatch(input) {
    calls.push({ method: "batch", input });
    return PUBLIC_PREVIEW;
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
  assert.ok(["customerSync", "masterData"].includes(capability));
  capabilityCalls.push(capability);
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
  body,
  headers = {},
  method = "GET"
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(actor ? { authorization: `Bearer ${actor}` } : {}),
      ...headers
    },
    body
  });
  const text = await response.text();
  let payload = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Template responses are deliberately plain CSV.
  }
  return { response, payload };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(authenticate);
  app.use("/api/mbt", createMbtRouter({
    importService,
    authorizePhase3Capability
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
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
  await closeDb();
});

test("P3-F06 HTTP: import templates are live-session Admin-only, no-store, and download-safe", async () => {
  const anonymous = await request("/api/mbt/config/imports/customers/template");
  assert.equal(anonymous.response.status, 401);

  const dispatcher = await request("/api/mbt/config/imports/customers/template", {
    actor: "dispatcher",
    headers: { "x-mbbs-role": "admin", "x-mbbs-roles": "admin" }
  });
  assert.equal(dispatcher.response.status, 403);
  assert.match(dispatcher.response.headers.get("cache-control") || "", /no-store/);

  const admin = await request("/api/mbt/config/imports/customers/template", { actor: "admin" });
  assert.equal(admin.response.status, 200);
  assert.equal(admin.response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(admin.response.headers.get("content-disposition"), 'attachment; filename="customers-v1.csv"');
  assert.match(admin.response.headers.get("cache-control") || "", /no-store/);
  assert.equal(admin.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(admin.payload, "customer_internal_id,entity_name,legal_name,display_name,active,currency,source_modified_at,source_version,account_id\r\n");
});

test("P3-F06 HTTP: customer file imports use local master-data authority without opening live sync", async () => {
  const capabilityStart = capabilityCalls.length;
  const result = await request("/api/mbt/config/imports/customers/template", {
    actor: "admin"
  });

  assert.equal(result.response.status, 200);
  assert.deepEqual(capabilityCalls.slice(capabilityStart), ["masterData"]);
});

test("P3-F06 HTTP: raw SpreadsheetML preview binds server actor and returns aggregate-only evidence", async () => {
  const workbook = buildCustomerSpreadsheetMl([syntheticCustomerRow({
    id: "940001",
    Name: "Synthetic HTTP Private Name",
    Email: "http-private@example.invalid"
  })]);
  const result = await request("/api/mbt/config/imports/customers/preview", {
    actor: "admin",
    method: "POST",
    headers: {
      "content-type": "application/vnd.ms-excel",
      "x-mbt-source-filename": "synthetic.xls",
      "x-mbt-source-account-id": CUSTOMER_IMPORT_DEFAULTS.sourceAccountId,
      "x-mbt-approved-subsidiary": CUSTOMER_IMPORT_DEFAULTS.approvedSubsidiary,
      "x-mbt-default-currency": CUSTOMER_IMPORT_DEFAULTS.defaultCurrency,
      "x-mbt-exported-at": CUSTOMER_IMPORT_DEFAULTS.exportedAt
    },
    body: workbook
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.match(result.response.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(result.payload, PUBLIC_PREVIEW);
  assert.equal(JSON.stringify(result.payload).includes("Synthetic HTTP Private Name"), false);
  assert.equal(JSON.stringify(result.payload).includes("http-private@example.invalid"), false);

  const call = calls.find(({ method }) => method === "preview");
  assert.ok(call);
  assert.deepEqual(call.input.actor, { operatorId: ACTORS.admin.id, roles: ["admin"] });
  assert.equal(call.input.resource, "customers");
  assert.equal(call.input.sourceKind, "netsuite_spreadsheetml");
  assert.equal(call.input.fileName, "synthetic.xls");
  assert.equal(Buffer.isBuffer(call.input.content), true);
  assert.equal(call.input.content.toString("utf8"), workbook);
  assert.deepEqual(call.input.defaults, CUSTOMER_IMPORT_DEFAULTS);
  assert.equal(Object.hasOwn(call.input, "role"), false);
});

test("P3-F07 HTTP: apply requires exact audit/idempotency inputs and batch reads remain private", async () => {
  const body = JSON.stringify({
    normalizedHash: NORMALIZED_HASH,
    targetRevisionToken: REVISION_TOKEN,
    reason: "Approve synthetic preview"
  });
  const noKey = await request(`/api/mbt/config/imports/customers/${BATCH_ID}/apply`, {
    actor: "admin",
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  assert.equal(noKey.response.status, 400);
  assert.equal(noKey.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");
  assert.match(noKey.response.headers.get("cache-control") || "", /no-store/);

  const applied = await request(`/api/mbt/config/imports/customers/${BATCH_ID}/apply`, {
    actor: "admin",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "p3-http-apply"
    },
    body
  });
  assert.equal(applied.response.status, 201);
  assert.equal(applied.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.match(applied.response.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(applied.payload, APPLY_BODY);

  const stored = await request(`/api/mbt/config/imports/customers/${BATCH_ID}`, { actor: "admin" });
  assert.equal(stored.response.status, 200);
  assert.match(stored.response.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(stored.payload, PUBLIC_PREVIEW);

  const applyCall = calls.find(({ method }) => method === "apply");
  assert.ok(applyCall);
  assert.equal(applyCall.input.batchId, BATCH_ID);
  assert.equal(applyCall.input.normalizedHash, NORMALIZED_HASH);
  assert.equal(applyCall.input.targetRevisionToken, REVISION_TOKEN);
  assert.equal(applyCall.input.reason, "Approve synthetic preview");
  assert.equal(applyCall.input.idempotencyKey, "p3-http-apply");
  assert.deepEqual(applyCall.input.actor, { operatorId: ACTORS.admin.id, roles: ["admin"] });
});

test("P3-F08 HTTP: disabled capability and unsupported resource fail before uploaded bytes reach service", async () => {
  const beforeCalls = calls.length;
  capabilityAllowed = false;
  try {
    const disabled = await request("/api/mbt/config/imports/customers/preview", {
      actor: "admin",
      method: "POST",
      headers: {
        "content-type": "text/csv",
        "x-mbt-source-filename": "synthetic.csv"
      },
      body: "Internal ID,Name\r\n940001,Synthetic"
    });
    assert.equal(disabled.response.status, 409);
    assert.equal(disabled.payload.code, "MBT_CAPABILITY_DISABLED");
    assert.match(disabled.response.headers.get("cache-control") || "", /no-store/);
  } finally {
    capabilityAllowed = true;
  }
  assert.equal(calls.length, beforeCalls);

  const unsupported = await request("/api/mbt/config/imports/yards/preview", {
    actor: "admin",
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "x-mbt-source-filename": "yards.csv"
    },
    body: "yard_code\r\n3445"
  });
  assert.equal(unsupported.response.status, 400);
  assert.equal(unsupported.payload.code, "MBT_IMPORT_RESOURCE_INVALID");
  assert.equal(calls.length, beforeCalls);
});

test("P3-F09 HTTP: local CSV resources use master-data authority and no customer-source headers", async () => {
  const template = await request("/api/mbt/config/imports/materials/template", { actor: "admin" });
  assert.equal(template.response.status, 200);
  assert.equal(template.response.headers.get("content-disposition"), 'attachment; filename="materials-v1.csv"');
  assert.equal(template.payload, "material_code,display_name,description,active,expected_revision\r\n");

  const result = await request("/api/mbt/config/imports/local-items/preview", {
    actor: "admin",
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "x-mbt-source-filename": "local-items.csv"
    },
    body: "item_code,display_name,category,pricing_mode,active\r\nSYNTH,Synthetic,service,rate_card,true"
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.resource, "local_items");
  assert.equal(result.payload.sourceKind, "csv");
  assert.match(result.response.headers.get("cache-control") || "", /no-store/);

  const call = calls.find(({ method, input }) => (
    method === "preview" && input.resource === "local_items"
  ));
  assert.ok(call);
  assert.equal(call.input.sourceKind, "csv");
  assert.deepEqual(call.input.defaults, { sourceAccountId: "local" });
  assert.equal(Object.hasOwn(call.input.defaults, "approvedSubsidiary"), false);
  assert.equal(Buffer.isBuffer(call.input.content), true);
  assert.equal(capabilityCalls.at(-1), "masterData");
});
