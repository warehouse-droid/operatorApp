import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  buildCustomerSpreadsheetMl,
  CUSTOMER_IMPORT_DEFAULTS,
  syntheticCustomerRow
} from "../support/master-data-import-fixtures.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const CUSTOMER_BASE = 8_000_000_000_000n
  + ((BigInt(`0x${RUN_ID.slice(0, 12)}`) % 1_000_000_000n) * 100n);
const ACTOR = Object.freeze({
  operatorId: `p3-import-admin-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
let sequence = 0;

function futureImportService() {
  return import("../../../src/mbt/master-data-import-service.js");
}

/** @param {number} offset */
function customerId(offset) {
  return String(CUSTOMER_BASE + BigInt(offset));
}

function identity(label) {
  sequence += 1;
  return `${label}-${RUN_ID}-${sequence}`;
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code);
}

/**
 * @param {readonly Record<string, unknown>[]} rows
 * @param {Partial<typeof CUSTOMER_IMPORT_DEFAULTS>} [defaultOverrides]
 */
async function previewRows(rows, defaultOverrides = {}) {
  const { previewMasterDataImport } = await futureImportService();
  const marker = identity("preview");
  return previewMasterDataImport({
    actor: ACTOR,
    resource: "customers",
    sourceKind: "netsuite_spreadsheetml",
    fileName: `${marker}.xls`,
    content: Buffer.from(buildCustomerSpreadsheetMl(rows)),
    defaults: { ...CUSTOMER_IMPORT_DEFAULTS, ...defaultOverrides },
    correlationId: `${marker}-correlation`,
    requestId: `${marker}-request`
  });
}

/** @param {Record<string, unknown>} preview @param {object} [overrides] */
async function applyPreview(preview, overrides = {}) {
  const { applyMasterDataImport } = await futureImportService();
  const marker = identity("apply");
  return applyMasterDataImport({
    actor: ACTOR,
    resource: "customers",
    batchId: preview.batchId,
    normalizedHash: preview.normalizedHash,
    targetRevisionToken: preview.targetRevisionToken,
    reason: "Apply synthetic customer bootstrap",
    idempotencyKey: marker,
    correlationId: `${marker}-correlation`,
    requestId: `${marker}-request`,
    ...overrides
  });
}

async function customerRows(ids) {
  const result = await query(
    `SELECT netsuite_id::text AS netsuite_id, entity_number, legal_name,
            display_name, currency, email, phone, active, source_version
       FROM netsuite_customers
      WHERE netsuite_id = ANY($1::bigint[])
      ORDER BY netsuite_id`,
    [ids]
  );
  return result.rows;
}

after(async () => {
  await closeDb();
});

test("P3-F06/P3-F08 import preview is aggregate-only, durable, and has no customer/outbox side effect", async () => {
  const ids = [customerId(1), customerId(2), customerId(3)];
  const rows = [
    syntheticCustomerRow({
      id: ids[0],
      Name: "Synthetic Preview Alpha",
      "Primary Contact": "MUST-NOT-PERSIST-IGNORED-CONTACT",
      Email: "preview-alpha@example.invalid"
    }),
    syntheticCustomerRow({
      id: ids[1],
      Name: "Synthetic Preview Beta",
      Phone: "+1-555-2002"
    }),
    syntheticCustomerRow({
      id: ids[2],
      "Primary Subsidiary": "Example Other Subsidiary"
    })
  ];
  const beforeOutbox = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  assert.deepEqual(await customerRows(ids), []);

  const preview = await previewRows(rows);
  assert.equal(preview.schemaVersion, "mbt-import-preview-v1");
  assert.equal(preview.resource, "customers");
  assert.equal(preview.sourceKind, "netsuite_spreadsheetml");
  assert.equal(preview.status, "previewed");
  assert.match(preview.batchId, /^[0-9a-f-]{36}$/);
  assert.match(preview.fileHash, /^[0-9a-f]{64}$/);
  assert.match(preview.normalizedHash, /^[0-9a-f]{64}$/);
  assert.match(preview.targetRevisionToken, /^[0-9a-f]{64}$/);
  assert.deepEqual(preview.summary, {
    totalRows: 3,
    validRows: 2,
    invalidRows: 0,
    skippedRows: 1,
    createdCandidates: 2,
    updatedCandidates: 0,
    unchangedCandidates: 0,
    conflictedCandidates: 0
  });
  assert.equal(Array.isArray(preview.warnings), true);
  assert.equal(Array.isArray(preview.errors), true);
  assert.equal(Object.hasOwn(preview, "rows"), false);
  assert.equal(Object.hasOwn(preview, "normalizedRows"), false);
  assert.equal(Object.hasOwn(preview, "content"), false);

  const publicJson = JSON.stringify(preview);
  for (const forbidden of [
    "Synthetic Preview Alpha",
    "Synthetic Preview Beta",
    "preview-alpha@example.invalid",
    "+1-555-2002",
    "MUST-NOT-PERSIST-IGNORED-CONTACT",
    ids[0],
    ids[1]
  ]) {
    assert.equal(publicJson.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(await customerRows(ids), []);
  const afterOutbox = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  assert.deepEqual(afterOutbox.rows[0], beforeOutbox.rows[0]);

  const { getMasterDataImportBatch } = await futureImportService();
  const stored = await getMasterDataImportBatch({
    actor: ACTOR,
    resource: "customers",
    batchId: preview.batchId
  });
  assert.deepEqual(stored, preview);

  const batchStorage = await query(
    "SELECT to_jsonb(batch_row)::text AS stored FROM mbt_import_batches batch_row WHERE batch_id = $1",
    [preview.batchId]
  );
  assert.equal(batchStorage.rowCount, 1);
  const storedBatch = String(batchStorage.rows[0].stored);
  assert.equal(storedBatch.includes("<Workbook"), false);
  assert.equal(storedBatch.includes("MUST-NOT-PERSIST-IGNORED-CONTACT"), false);
  assert.equal(storedBatch.includes("preview-alpha@example.invalid"), false);
});

test("P3-F07 import apply is atomic, records csv_bootstrap provenance, and exact retry is side-effect free", async () => {
  const ids = [customerId(10), customerId(11)];
  const preview = await previewRows([
    syntheticCustomerRow({ id: ids[0], Name: "Synthetic Atomic Alpha" }),
    syntheticCustomerRow({ id: ids[1], Name: "741011 Synthetic Atomic Beta" })
  ]);
  const idempotencyKey = identity("exact-retry");
  const input = {
    idempotencyKey,
    correlationId: `${idempotencyKey}-correlation`,
    requestId: `${idempotencyKey}-request`
  };
  const first = await applyPreview(preview, input);
  const replay = await applyPreview(preview, input);

  assert.equal(first.status, 201);
  assert.equal(first.replayed, false);
  assert.equal(replay.status, first.status);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  assert.deepEqual(first.body, {
    schemaVersion: "mbt-import-apply-v1",
    batchId: preview.batchId,
    resource: "customers",
    normalizedHash: preview.normalizedHash,
    status: "applied",
    counts: {
      created: 2,
      updated: 0,
      unchanged: 0,
      conflicted: 0
    },
    entityIds: ids
  });

  const imported = await customerRows(ids);
  assert.deepEqual(imported.map((row) => ({
    netsuite_id: row.netsuite_id,
    entity_number: row.entity_number,
    legal_name: row.legal_name,
    currency: row.currency,
    active: row.active
  })), [
    {
      netsuite_id: ids[0],
      entity_number: `NSID-${ids[0]}`,
      legal_name: "Synthetic Atomic Alpha",
      currency: "CAD",
      active: true
    },
    {
      netsuite_id: ids[1],
      entity_number: "741011",
      legal_name: "741011 Synthetic Atomic Beta",
      currency: "CAD",
      active: true
    }
  ]);

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_import_apply_results WHERE batch_id = $1) AS apply_results,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $2
           AND command_name = 'mbt.import.customers.apply'
           AND idempotency_key = $3) AS receipts,
       (SELECT count(*)::int FROM mbt_netsuite_outbox
         WHERE created_at >= (SELECT created_at FROM mbt_import_batches WHERE batch_id = $1)) AS outbox_rows`,
    [preview.batchId, ACTOR.operatorId, idempotencyKey]
  );
  assert.deepEqual(evidence.rows[0], { apply_results: 2, receipts: 1, outbox_rows: 0 });

  const provenance = await query(
    `SELECT entity_id, source_kind, source_account_id, source_version
       FROM mbt_import_apply_results
      WHERE batch_id = $1
      ORDER BY entity_id`,
    [preview.batchId]
  );
  assert.deepEqual(provenance.rows.map((row) => ({
    entity_id: row.entity_id,
    source_kind: row.source_kind,
    source_account_id: row.source_account_id
  })), ids.map((id) => ({
    entity_id: id,
    source_kind: "csv_bootstrap",
    source_account_id: "synthetic-account"
  })));
  assert.ok(provenance.rows.every(({ source_version }) => String(source_version).length > 0));
});

test("P3-F07 apply binds batch, normalized hash, revision token, reason, and idempotency identity", async () => {
  const id = customerId(20);
  const preview = await previewRows([syntheticCustomerRow({ id, Name: "Synthetic Binding" })]);
  const key = identity("binding");
  const first = await applyPreview(preview, { idempotencyKey: key });
  assert.equal(first.status, 201);

  for (const changed of [
    { reason: "Changed audit reason" },
    { normalizedHash: "f".repeat(64) },
    { targetRevisionToken: "e".repeat(64) }
  ]) {
    await assert.rejects(
      () => applyPreview(preview, { idempotencyKey: key, ...changed }),
      (error) => hasCode(error, "MBT_IDEMPOTENCY_CONFLICT")
    );
  }

  await assert.rejects(
    () => applyPreview(preview, {
      idempotencyKey: identity("wrong-hash"),
      normalizedHash: "d".repeat(64)
    }),
    (error) => hasCode(error, "MBT_IMPORT_HASH_MISMATCH")
  );
  await assert.rejects(
    () => applyPreview(preview, {
      idempotencyKey: identity("wrong-revision"),
      targetRevisionToken: "c".repeat(64)
    }),
    (error) => hasCode(error, "MBT_IMPORT_STALE_REVISION")
  );
  assert.equal((await customerRows([id])).length, 1);
});

test("P3-F07/P3-F08 a target conflict after preview rolls back every earlier row", async () => {
  const ids = [customerId(30), customerId(31)];
  const preview = await previewRows([
    syntheticCustomerRow({ id: ids[0], Name: "Synthetic Rollback First" }),
    syntheticCustomerRow({ id: ids[1], Name: "Synthetic Rollback Collision" })
  ]);
  const occupyingId = customerId(32);
  await query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, currency,
       active, source_modified_at, source_version, payload_hash
     ) VALUES ($1, $2, $3, $3, 'CAD', true, $4, $5, $6)`,
    [
      occupyingId,
      `NSID-${ids[1]}`,
      "Synthetic Existing Collision",
      "2026-08-03T11:00:00.000Z",
      "synthetic-existing-v1",
      crypto.createHash("sha256").update("synthetic-existing").digest("hex")
    ]
  );
  const beforeOutbox = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");

  await assert.rejects(
    () => applyPreview(preview),
    (error) => hasCode(error, "MBT_IMPORT_TARGET_CONFLICT")
      || hasCode(error, "MBT_IMPORT_STALE_REVISION")
  );
  assert.deepEqual(await customerRows(ids), []);
  assert.equal((await customerRows([occupyingId]))[0].legal_name, "Synthetic Existing Collision");
  const afterOutbox = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  assert.deepEqual(afterOutbox.rows[0], beforeOutbox.rows[0]);

  const partialEvidence = await query(
    "SELECT count(*)::int AS count FROM mbt_import_apply_results WHERE batch_id = $1",
    [preview.batchId]
  );
  assert.deepEqual(partialEvidence.rows[0], { count: 0 });
});

test("P3-F07 hardening: a post-canonical failure rolls back customers and all import evidence", async () => {
  const ids = [customerId(40), customerId(41)];
  const preview = await previewRows([
    syntheticCustomerRow({ id: ids[0], Name: "Synthetic Nested Rollback Alpha" }),
    syntheticCustomerRow({ id: ids[1], Name: "Synthetic Nested Rollback Beta" })
  ]);
  const idempotencyKey = identity("nested-transaction-rollback");
  const beforeOutbox = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  let hookCalls = 0;

  await assert.rejects(
    () => applyPreview(preview, {
      idempotencyKey,
      hooks: {
        afterCanonicalApply() {
          hookCalls += 1;
          throw new Error("INJECTED_IMPORT_POST_CANONICAL_FAILURE");
        }
      }
    }),
    /INJECTED_IMPORT_POST_CANONICAL_FAILURE/
  );
  assert.equal(hookCalls, 1);
  assert.deepEqual(await customerRows(ids), []);
  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_import_apply_results WHERE batch_id = $1) AS apply_results,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $2
           AND command_name = 'mbt.import.customers.apply'
           AND idempotency_key = $3) AS receipts,
       (SELECT status FROM mbt_import_batches WHERE batch_id = $1) AS batch_status,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox_rows`,
    [preview.batchId, ACTOR.operatorId, idempotencyKey]
  );
  assert.deepEqual(evidence.rows[0], {
    apply_results: 0,
    receipts: 0,
    batch_status: "previewed",
    outbox_rows: beforeOutbox.rows[0].count
  });
});

test("P3-F08 import storage has bounded normalized evidence but no raw-upload column", async () => {
  const expectedTables = [
    "mbt_import_apply_results",
    "mbt_import_batches",
    "mbt_import_row_errors",
    "mbt_import_staged_rows"
  ];
  const tables = await query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [expectedTables]
  );
  assert.deepEqual(tables.rows.map(({ table_name: tableName }) => tableName), expectedTables);

  const prohibitedColumns = await query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name LIKE 'mbt_import_%'
        AND column_name = ANY($1::text[])
      ORDER BY table_name, column_name`,
    [["raw_file", "raw_content", "file_bytes", "source_bytes", "uploaded_file", "uploaded_content"]]
  );
  assert.deepEqual(prohibitedColumns.rows, []);

  const bounds = await query(
    `SELECT table_name, constraint_name
       FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
        AND constraint_type IN ('CHECK', 'UNIQUE')
      ORDER BY table_name, constraint_name`,
    [expectedTables]
  );
  assert.ok(bounds.rows.some(({ constraint_name: name }) => /hash/i.test(name)));
  assert.ok(bounds.rows.some(({ constraint_name: name }) => /row/i.test(name)));
  assert.ok(bounds.rows.some(({ constraint_name: name }) => /idempot/i.test(name)));
});
