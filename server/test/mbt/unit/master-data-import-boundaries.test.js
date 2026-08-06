// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMasterDataImport,
  getMasterDataImportBatch,
  getTemplate,
  previewMasterDataImport
} from "../../../src/mbt/master-data-import-service.js";

const ACTOR = Object.freeze({ operatorId: "p3-import-boundary-admin", roles: Object.freeze(["admin"]) });
const HASH = "a".repeat(64);

/** @param {unknown} error @param {string} code @param {number} [status] */
function exactError(error, code, status = 400) {
  return Boolean(error && typeof error === "object"
    && error.code === code
    && error.status === status);
}

function preview(overrides = {}) {
  return previewMasterDataImport({
    actor: ACTOR,
    resource: "customers",
    sourceKind: "customer_csv",
    fileName: "synthetic.csv",
    content: "header",
    defaults: {},
    correlationId: "p3-import-boundary-correlation",
    requestId: "p3-import-boundary-request",
    ...overrides
  });
}

function apply(overrides = {}) {
  return applyMasterDataImport({
    actor: ACTOR,
    resource: "customers",
    batchId: "synthetic-batch",
    normalizedHash: HASH,
    targetRevisionToken: HASH,
    reason: "P3 import boundary evidence",
    idempotencyKey: "p3-import-boundary-idempotency",
    correlationId: "p3-import-boundary-correlation",
    requestId: "p3-import-boundary-request",
    ...overrides
  });
}

test("P3-F06 import boundary requires a structured authenticated Admin before any file work", async () => {
  for (const actor of [null, "admin", [], {}, { operatorId: "admin", roles: "admin" }, {
    operatorId: "admin",
    roles: ["sales"]
  }]) {
    await assert.rejects(
      () => preview({ actor }),
      (error) => exactError(error, "MBT_IMPORT_ACTOR_REQUIRED", 403)
    );
  }

  await assert.rejects(
    () => preview({
      actor: { operatorId: " p3-import-normalized ", roles: ["", null, " AdMiN "] },
      resource: "unsupported"
    }),
    (error) => exactError(error, "MBT_IMPORT_RESOURCE_INVALID")
  );
});

test("P3-F06 import resource and source identities normalize narrowly", async () => {
  for (const resource of [undefined, null, 0, "", "service_templates", "../customers"]) {
    await assert.rejects(
      () => getTemplate({ resource }),
      (error) => exactError(error, "MBT_IMPORT_RESOURCE_INVALID")
    );
  }

  const templates = await Promise.all([
    getTemplate({ resource: "CUSTOMERS" }),
    getTemplate({ resource: "local-items" }),
    getTemplate({ resource: "materials" }),
    getTemplate({ resource: "dump-sites" })
  ]);
  assert.deepEqual(templates.map(({ filename }) => filename), [
    "customers-v1.csv",
    "local_items-v1.csv",
    "materials-v1.csv",
    "dump_sites-v1.csv"
  ]);
  assert.ok(templates.every(({ status, contentType, body }) => (
    status === 200
      && contentType === "text/csv; charset=utf-8"
      && typeof body === "string"
      && body.length > 0
      && !body.includes("\r\n")
  )));

  for (const [resource, sourceKind] of [
    ["customers", "csv"],
    ["customers", "spreadsheetml"],
    ["materials", "customer_csv"],
    ["dump_sites", null]
  ]) {
    await assert.rejects(
      () => preview({ resource, sourceKind }),
      (error) => exactError(error, "MBT_IMPORT_SOURCE_INVALID")
    );
  }
});

test("P3-F06 import content and defaults reject permissive coercion before parsing or persistence", async () => {
  for (const content of [null, undefined, {}, [], 42]) {
    await assert.rejects(
      () => preview({ content }),
      (error) => exactError(error, "MBT_IMPORT_CONTENT_REQUIRED")
    );
  }
  for (const [content, defaults] of [
    ["synthetic", null],
    [Buffer.from("synthetic"), []],
    [new Uint8Array(Buffer.from("synthetic")), "defaults"]
  ]) {
    await assert.rejects(
      () => preview({ content, defaults }),
      (error) => exactError(error, "MBT_IMPORT_DEFAULT_REQUIRED")
    );
  }
});

test("P3-F07 apply validates batch and hashes while a customer-import note remains optional", async () => {
  await assert.rejects(
    () => apply({ batchId: "  " }),
    (error) => exactError(error, "MBT_IMPORT_BATCH_REQUIRED")
  );
  for (const normalizedHash of [null, "", "A".repeat(64), "a".repeat(63), `${HASH}0`]) {
    await assert.rejects(
      () => apply({ normalizedHash }),
      (error) => exactError(error, "MBT_IMPORT_HASH_MISMATCH")
    );
  }
  for (const targetRevisionToken of [null, "", "g".repeat(64), "0".repeat(63)]) {
    await assert.rejects(
      () => apply({ targetRevisionToken }),
      (error) => exactError(error, "MBT_IMPORT_STALE_REVISION")
    );
  }
  await assert.rejects(
    () => apply({
      batchId: "00000000-0000-4000-8000-000000000001",
      reason: "\t",
      idempotencyKey: "p3-import-boundary-optional-reason"
    }),
    (error) => exactError(error, "MBT_IMPORT_BATCH_NOT_FOUND", 404)
  );
});

test("P3-F06 retained preview lookup rejects malformed scope before a database query", async () => {
  await assert.rejects(
    () => getMasterDataImportBatch({ actor: ACTOR, resource: "customers", batchId: " " }),
    (error) => exactError(error, "MBT_IMPORT_BATCH_REQUIRED")
  );
  await assert.rejects(
    () => getMasterDataImportBatch({ actor: ACTOR, resource: "unknown", batchId: "synthetic" }),
    (error) => exactError(error, "MBT_IMPORT_RESOURCE_INVALID")
  );
  await assert.rejects(
    () => getMasterDataImportBatch({
      actor: { operatorId: "p3-import-boundary-sales", roles: ["sales"] },
      resource: "customers",
      batchId: "synthetic"
    }),
    (error) => exactError(error, "MBT_IMPORT_ACTOR_REQUIRED", 403)
  );
});
