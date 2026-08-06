// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  applyMbtBinAssetCsvImport,
  previewMbtBinAssetCsvImport
} from "../../../src/mbt/asset-csv-import-service.js";
import { serializeCsv } from "../../../src/mbt/bounded-csv.js";
import {
  ASSET_CSV_HEADERS,
  assetCsvRows,
  buildAssetCsvFile
} from "../support/asset-csv-import-fixtures.js";
import { createAssetFixture } from "../support/asset-fixtures.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({ operatorId: `p35-hard-${RUN_ID}`, roles: Object.freeze(["admin"]) });
let sequence = 0;

after(closeDb);

/** @param {() => Promise<unknown>} operation */
async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

/** @param {() => Promise<unknown>} operation */
async function withAssetManagementEnabled(operation) {
  const before = {
    root: config.mbt.enabled,
    assets: config.mbtPhase3.assetManagementEnabled
  };
  config.mbt.enabled = true;
  config.mbtPhase3.assetManagementEnabled = true;
  await query(
    `UPDATE mbt_feature_flags SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_asset_management"], ACTOR.operatorId]
  );
  try {
    return await operation();
  } finally {
    config.mbt.enabled = before.root;
    config.mbtPhase3.assetManagementEnabled = before.assets;
  }
}

/** @param {string} suffix @param {readonly Record<string, unknown>[]} [rows] */
function previewInput(suffix, rows) {
  sequence += 1;
  const file = buildAssetCsvFile({ suffix: `${suffix}_${RUN_ID.slice(0, 8)}`, ...(rows ? { rows } : {}) });
  return {
    actor: ACTOR,
    content: file.content,
    fileName: file.fileName,
    correlationId: `p35-hard-preview-corr-${sequence}`,
    requestId: `p35-hard-preview-req-${sequence}`
  };
}

/** @param {Record<string, any>} preview @param {Record<string, unknown>} [extra] */
function applyInput(preview, extra = {}) {
  sequence += 1;
  return {
    actor: ACTOR,
    batchId: preview.batchId,
    normalizedHash: preview.normalizedHash,
    targetRevisionToken: preview.targetRevisionToken,
    reason: "Apply hardened synthetic opening inventory",
    idempotencyKey: `p35-hard-apply-${RUN_ID}-${sequence}`,
    correlationId: `p35-hard-apply-corr-${sequence}`,
    requestId: `p35-hard-apply-req-${sequence}`,
    ...extra
  };
}

test("P3-F11 CSV service hardening: malformed actors, command identities, and empty files fail before staging", async () => {
  await inRollback(() => withAssetManagementEnabled(async () => {
    const valid = previewInput("INPUTS");
    await assert.rejects(
      () => previewMbtBinAssetCsvImport({ ...valid, actor: /** @type {any} */ (null) }),
      (error) => error?.status === 403 && error?.code === "MBT_ADMIN_REQUIRED"
    );
    await assert.rejects(
      () => previewMbtBinAssetCsvImport({ ...valid, actor: /** @type {any} */ ({ operatorId: "x", roles: "admin" }) }),
      (error) => error?.status === 403 && error?.code === "MBT_ADMIN_REQUIRED"
    );
    await assert.rejects(
      () => previewMbtBinAssetCsvImport({ ...valid, correlationId: "" }),
      (error) => error?.status === 400 && error?.code === "MBT_CORRELATION_ID_REQUIRED"
    );
    await assert.rejects(
      () => previewMbtBinAssetCsvImport({ ...valid, requestId: "" }),
      (error) => error?.status === 400 && error?.code === "MBT_REQUEST_ID_REQUIRED"
    );

    const emptyCsv = serializeCsv({ headers: ASSET_CSV_HEADERS, rows: [] });
    await assert.rejects(
      () => previewMbtBinAssetCsvImport({
        ...valid,
        actor: { operatorId: ACTOR.operatorId, roles: ["", "ADMIN"] },
        content: emptyCsv
      }),
      (error) => error?.status === 400 && error?.code === "MBT_ASSET_CSV_EMPTY"
    );

    const preview = await previewMbtBinAssetCsvImport(previewInput("HASHES"));
    for (const [label, extra, code] of [
      ["normalized hash", { normalizedHash: "bad" }, "MBT_IMPORT_HASH_MISMATCH"],
      ["target revision", { targetRevisionToken: "mbt-test-invalid" }, "MBT_ASSET_IMPORT_STALE_REVISION"]
    ]) {
      await assert.rejects(
        () => applyMbtBinAssetCsvImport(applyInput(preview, extra)),
        (error) => error?.status === 400 && error?.code === code,
        label
      );
    }
    const withoutEnteredReason = await applyMbtBinAssetCsvImport(
      applyInput(preview, { reason: "" })
    );
    assert.equal(withoutEnteredReason.body.summary.created, assetCsvRows().length);
  }));
});

test("P3-F11 CSV service hardening: every supported opening location resolves through active shared references", async () => {
  await inRollback(() => withAssetManagementEnabled(async () => {
    const fixture = await createAssetFixture(/** @type {any} */ ({ query }), { assetCount: 0, visitCount: 0 });
    const conditionCode = `P35_OK_${RUN_ID.slice(0, 8)}`;
    const dumpCode = `P35_DUMP_${RUN_ID.slice(0, 8)}`;
    await query(
      `INSERT INTO mbt_bin_condition_codes (condition_code, display_name, created_by, updated_by)
       VALUES ($1, $1, $2, $2)`,
      [conditionCode, ACTOR.operatorId]
    );
    await query(
      `INSERT INTO mbt_dump_sites (dump_site_id, dump_site_code, display_name, created_by, updated_by)
       VALUES ($1, $2, $2, $3, $3)`,
      [crypto.randomUUID(), dumpCode, ACTOR.operatorId]
    );

    const base = assetCsvRows("LOCATIONS")[0];
    const opening = [
      ["CUSTOMER", "at_customer", "customer_site", fixture.customerSiteProfileId],
      ["DUMP", "at_dump", "dump_site", dumpCode],
      ["TRUCK", "on_truck", "truck", fixture.truckId],
      ["UNKNOWN", "lost", "unknown", ""]
    ].map(([name, status, kind, identity]) => ({
      ...base,
      asset_code: `P35CSV-HARD-${RUN_ID.slice(0, 8)}-${name}`,
      qr_code: "",
      barcode: "",
      condition_code: conditionCode,
      initial_lifecycle_status: status,
      initial_location_kind: kind,
      initial_location_identity: identity,
      initial_location_reference: identity || "Unknown after physical inventory"
    }));
    const preview = await previewMbtBinAssetCsvImport(previewInput("LOCATIONS", opening));
    assert.deepEqual(preview.rows.map((row) => row.initialLocationKind), [
      "customer_site", "dump_site", "truck", "unknown"
    ]);
    const applied = await applyMbtBinAssetCsvImport(applyInput(preview));
    assert.equal(applied.body.summary.created, 4);

    await assert.rejects(
      () => previewMbtBinAssetCsvImport(previewInput("LOCATION_DUP", opening)),
      (error) => error?.status === 409 && error?.code === "MBT_ASSET_DUPLICATE"
    );
  }));
});

test("P3-F11 CSV service hardening: invalid customer/truck references and tampered preview evidence fail closed", async () => {
  await inRollback(() => withAssetManagementEnabled(async () => {
    for (const [label, status, kind, identity] of [
      ["customer", "at_customer", "customer_site", "not-a-uuid"],
      ["truck", "on_truck", "truck", "0"]
    ]) {
      const rows = assetCsvRows(`BAD_${label}`);
      Object.assign(rows[0], {
        initial_lifecycle_status: status,
        initial_location_kind: kind,
        initial_location_identity: identity
      });
      await assert.rejects(
        () => previewMbtBinAssetCsvImport(previewInput(`BAD_${label}`, rows)),
        (error) => error?.status === 400 && error?.code === "MBT_ASSET_REFERENCE_INVALID",
        label
      );
    }

    const target = await previewMbtBinAssetCsvImport(previewInput("TARGET"));
    await query(
      "UPDATE mbt_import_batches SET target_revision_token = $2 WHERE batch_id = $1",
      [target.batchId, "0".repeat(64)]
    );
    await assert.rejects(
      () => applyMbtBinAssetCsvImport(applyInput(target)),
      (error) => error?.status === 409 && error?.code === "MBT_ASSET_IMPORT_STALE_REVISION"
    );

    const status = await previewMbtBinAssetCsvImport(previewInput("STATUS"));
    await query("UPDATE mbt_import_batches SET status = 'failed' WHERE batch_id = $1", [status.batchId]);
    await assert.rejects(
      () => applyMbtBinAssetCsvImport(applyInput(status)),
      (error) => error?.status === 409 && error?.code === "MBT_IMPORT_BATCH_NOT_APPLICABLE"
    );

    const missing = await previewMbtBinAssetCsvImport(previewInput("MISSING"));
    await query("DELETE FROM mbt_import_staged_rows WHERE batch_id = $1", [missing.batchId]);
    await assert.rejects(
      () => applyMbtBinAssetCsvImport(applyInput(missing)),
      (error) => error?.status === 409 && error?.code === "MBT_IMPORT_BATCH_NOT_APPLICABLE"
    );

    const rowHash = await previewMbtBinAssetCsvImport(previewInput("ROW_HASH"));
    await query(
      `UPDATE mbt_import_staged_rows SET payload_hash = $2
        WHERE batch_id = $1 AND row_number = 2`,
      [rowHash.batchId, "0".repeat(64)]
    );
    await assert.rejects(
      () => applyMbtBinAssetCsvImport(applyInput(rowHash)),
      (error) => error?.status === 409 && error?.code === "MBT_IMPORT_HASH_MISMATCH"
    );

    const stagedHash = await previewMbtBinAssetCsvImport(previewInput("STAGED_HASH"));
    await query(
      "DELETE FROM mbt_import_staged_rows WHERE batch_id = $1 AND row_number = 3",
      [stagedHash.batchId]
    );
    await assert.rejects(
      () => applyMbtBinAssetCsvImport(applyInput(stagedHash)),
      (error) => error?.status === 409 && error?.code === "MBT_IMPORT_HASH_MISMATCH"
    );
  }));
});
