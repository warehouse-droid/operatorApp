// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({ operatorId: `p3-local-import-${RUN_ID}`, roles: Object.freeze(["admin"]) });
let sequence = 0;
let priorConfig;
let priorFlags;

function identity(label) {
  sequence += 1;
  return `${label}-${RUN_ID}-${sequence}`;
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code);
}

async function importService() {
  return import("../../../src/mbt/master-data-import-service.js");
}

/** @param {string} resource @param {string} csv */
async function preview(resource, csv) {
  const service = await importService();
  const marker = identity("preview");
  return service.previewMasterDataImport({
    actor: ACTOR,
    resource,
    sourceKind: "csv",
    fileName: `${resource}.csv`,
    content: Buffer.from(csv),
    defaults: { sourceAccountId: "local" },
    correlationId: `${marker}-correlation`,
    requestId: `${marker}-request`
  });
}

/** @param {Record<string, any>} batch @param {object} [overrides] */
async function apply(batch, overrides = {}) {
  const service = await importService();
  const marker = identity("apply");
  return service.applyMasterDataImport({
    actor: ACTOR,
    resource: batch.resource,
    batchId: batch.batchId,
    normalizedHash: batch.normalizedHash,
    targetRevisionToken: batch.targetRevisionToken,
    reason: "Apply synthetic local-resource CSV",
    idempotencyKey: marker,
    correlationId: `${marker}-correlation`,
    requestId: `${marker}-request`,
    ...overrides
  });
}

before(async () => {
  priorConfig = {
    root: config.mbt.enabled,
    master: config.mbtPhase3.masterDataEnabled
  };
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  priorFlags = (await query(
    `SELECT flag_key, enabled, revision, updated_by, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"]]
  )).rows;
  await query(
    `UPDATE mbt_feature_flags SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
  );
});

after(async () => {
  config.mbt.enabled = priorConfig.root;
  config.mbtPhase3.masterDataEnabled = priorConfig.master;
  await Promise.all((priorFlags || []).map((flag) => query(
      `UPDATE mbt_feature_flags
          SET enabled = $2, revision = $3, updated_by = $4, updated_at = $5
        WHERE flag_key = $1`,
      [flag.flag_key, flag.enabled, flag.revision, flag.updated_by, flag.updated_at]
    )));
  await closeDb();
});

test("P3-F09 unified import: local items preview without side effects then apply and replay exactly", async () => {
  const code = `CSV_SERVICE_${RUN_ID.slice(0, 10)}`;
  const csv = [
    "item_code,display_name,description,category,pricing_mode,applicable_service_types,applicable_legacy_source_types,bin_type_code,netsuite_mapping_local_key,active,expected_revision",
    `${code},Private synthetic service,CSV configured,service,rate_card,delivery|exchange,SO|TO,,,true,`
  ].join("\r\n");
  const batch = await preview("local_items", csv);

  assert.equal(batch.resource, "local_items");
  assert.equal(batch.sourceKind, "csv");
  assert.deepEqual(batch.summary, {
    totalRows: 1,
    validRows: 1,
    invalidRows: 0,
    skippedRows: 0,
    createdCandidates: 1,
    updatedCandidates: 0,
    unchangedCandidates: 0,
    conflictedCandidates: 0
  });
  assert.equal(JSON.stringify(batch).includes("Private synthetic service"), false);
  assert.equal((await query("SELECT count(*)::int AS count FROM mbt_local_item_settings WHERE item_code = $1", [code])).rows[0].count, 0);

  const idempotencyKey = identity("local-item-replay");
  const common = {
    idempotencyKey,
    correlationId: `${idempotencyKey}-correlation`,
    requestId: `${idempotencyKey}-request`
  };
  const first = await apply(batch, common);
  const replay = await apply(batch, common);
  assert.equal(first.status, 201);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  assert.deepEqual(first.body.counts, { created: 1, updated: 0, unchanged: 0, conflicted: 0 });
  assert.deepEqual(first.body.entityIds, [code]);

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_local_item_settings WHERE item_code = $1) AS domain_rows,
       (SELECT count(*)::int FROM mbt_import_apply_results WHERE batch_id = $2) AS result_rows,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE command_name = 'mbt.import.local_items.apply' AND idempotency_key = $3) AS outer_receipts`,
    [code, batch.batchId, idempotencyKey]
  );
  assert.deepEqual(evidence.rows[0], { domain_rows: 1, result_rows: 1, outer_receipts: 1 });
});

test("P3-F09 unified import: materials and dump sites validate references and apply through their manual validator", async () => {
  const materialCode = `MAT_${RUN_ID.slice(0, 12)}`;
  const material = await preview("materials", [
    "material_code,display_name,description,active,expected_revision",
    `${materialCode},Synthetic material,No production data,true,`
  ].join("\n"));
  await apply(material);

  const dumpCode = `DUMP_${RUN_ID.slice(0, 11)}`;
  const dump = await preview("dump_sites", [
    "dump_site_code,display_name,address_line_1,address_line_2,city,region,postal_code,country_code,phone,latitude,longitude,material_code,accepted,scale_ticket_required,notes,active,expected_revision",
    `${dumpCode},Synthetic dump,1 Example Rd,,Toronto,ON,A1A 1A1,CA,,43.1,-79.2,${materialCode},true,true,Scale required,true,`
  ].join("\n"));
  assert.equal((await query("SELECT count(*)::int AS count FROM mbt_dump_sites WHERE dump_site_code = $1", [dumpCode])).rows[0].count, 0);
  const applied = await apply(dump);
  assert.deepEqual(applied.body.counts, { created: 1, updated: 0, unchanged: 0, conflicted: 0 });

  const stored = await query(
    `SELECT site.dump_site_code, material.material_code, acceptance.accepted,
            acceptance.scale_ticket_required
       FROM mbt_dump_sites site
       JOIN mbt_dump_site_materials acceptance USING (dump_site_id)
       JOIN mbt_materials material USING (material_id)
      WHERE site.dump_site_code = $1`,
    [dumpCode]
  );
  assert.deepEqual(stored.rows, [{
    dump_site_code: dumpCode,
    material_code: materialCode,
    accepted: true,
    scale_ticket_required: true
  }]);

  await assert.rejects(
    () => preview("dump_sites", [
      "dump_site_code,display_name,country_code,material_code,accepted,scale_ticket_required,active",
      `BAD_${RUN_ID.slice(0, 10)},Bad reference,CA,DOES_NOT_EXIST,true,false,true`
    ].join("\n")),
    (error) => hasCode(error, "MBT_MASTER_REFERENCE_INVALID")
  );
});

test("P3-F09 unified import: a target revision change after preview fails before any CSV write", async () => {
  const materialCode = `STALE_${RUN_ID.slice(0, 10)}`;
  const first = await preview("materials", [
    "material_code,display_name,description,active,expected_revision",
    `${materialCode},Initial material,,true,`
  ].join("\n"));
  await apply(first);

  const stale = await preview("materials", [
    "material_code,display_name,description,active,expected_revision",
    `${materialCode},CSV intended update,,true,1`
  ].join("\n"));
  assert.equal(stale.summary.updatedCandidates, 1);

  const local = await import("../../../src/mbt/local-master-data-service.js");
  const marker = identity("manual-race");
  await local.applyLocalMasterDataRows({
    actor: ACTOR,
    resource: "materials",
    sourceKind: "manual",
    rows: [{
      materialCode,
      displayName: "Winning manual update",
      description: "",
      active: true,
      expectedRevision: 1
    }],
    reason: "Synthetic competing update",
    idempotencyKey: marker,
    correlationId: `${marker}-correlation`,
    requestId: `${marker}-request`
  });

  await assert.rejects(
    () => apply(stale),
    (error) => hasCode(error, "MBT_IMPORT_STALE_REVISION")
  );
  const stored = await query(
    "SELECT display_name, revision::int FROM mbt_materials WHERE material_code = $1",
    [materialCode]
  );
  assert.deepEqual(stored.rows, [{ display_name: "Winning manual update", revision: 2 }]);
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM mbt_import_apply_results WHERE batch_id = $1",
    [stale.batchId]
  )).rows[0].count, 0);
});
