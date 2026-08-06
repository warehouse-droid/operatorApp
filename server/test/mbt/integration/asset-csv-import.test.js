// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { buildAssetCsvFile } from "../support/asset-csv-import-fixtures.js";

const SERVICE_PATH = "../../../src/mbt/" + "asset-csv-import-service.js";
const service = /** @type {Record<string, Function>} */ (await import(SERVICE_PATH).catch(() => ({})));
const registry = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/asset-registry-service.js"
));
const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({ operatorId: `p35-csv-${RUN_ID}`, roles: Object.freeze(["admin"]) });
let sequence = 0;

after(async () => {
  await closeDb();
});

/** @param {Record<string, Function>} source @param {string} name */
function requiredOperation(source, name) {
  const operation = source[name];
  assert.equal(typeof operation, "function", `P3.5a requires ${name}.`);
  return operation;
}

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

/** @param {string} suffix */
function previewInput(suffix) {
  sequence += 1;
  const file = buildAssetCsvFile({ suffix: `${suffix}_${RUN_ID.slice(0, 8)}` });
  return {
    actor: ACTOR,
    content: file.content,
    fileName: file.fileName,
    correlationId: `p35-csv-preview-corr-${RUN_ID}-${sequence}`,
    requestId: `p35-csv-preview-req-${RUN_ID}-${sequence}`
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
    reason: "Apply synthetic opening asset inventory",
    idempotencyKey: `p35-csv-apply-${RUN_ID}-${sequence}`,
    correlationId: `p35-csv-apply-corr-${RUN_ID}-${sequence}`,
    requestId: `p35-csv-apply-req-${RUN_ID}-${sequence}`,
    ...extra
  };
}

/** @param {string} prefix */
async function domainCounts(prefix) {
  const result = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_bin_assets WHERE asset_code LIKE $1) AS assets,
       (SELECT count(*)::int FROM mbt_bin_movements movement
         JOIN mbt_bin_assets asset USING (asset_id) WHERE asset.asset_code LIKE $1) AS movements,
       (SELECT count(*)::int FROM mbt_bin_asset_state state
         JOIN mbt_bin_assets asset USING (asset_id) WHERE asset.asset_code LIKE $1) AS states,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox`,
    [`${prefix}%`]
  );
  return result.rows[0];
}

test("P3-F11 CSV preview: only actor-owned staged evidence changes and uses the manual validator", async () => {
  await inRollback(() => withAssetManagementEnabled(async () => {
    const previewImport = requiredOperation(service, "previewMbtBinAssetCsvImport");
    const normalizeRegistration = requiredOperation(registry, "normalizeMbtBinAssetRegistration");
    const input = previewInput("PREVIEW");
    const prefix = `P35CSV-PREVIEW_${RUN_ID.slice(0, 8)}`;
    const before = await domainCounts(prefix);
    const preview = await previewImport(input);
    assert.equal(preview.schemaVersion, "mbt-bin-assets-import-preview-v1");
    assert.equal(preview.status, "previewed");
    assert.equal(preview.rows.length, 2);
    assert.match(preview.batchId, /^[0-9a-f-]{36}$/u);
    assert.match(preview.normalizedHash, /^[0-9a-f]{64}$/u);
    assert.match(preview.targetRevisionToken, /^[0-9a-f]{64}$/u);
    assert.deepEqual(await domainCounts(prefix), before);

    const staged = await query(
      `SELECT batch.resource_kind, batch.status, batch.actor_operator_id,
              staged.row_number, staged.normalized_payload
         FROM mbt_import_batches batch
         JOIN mbt_import_staged_rows staged USING (batch_id)
        WHERE batch.batch_id = $1
        ORDER BY staged.row_number`,
      [preview.batchId]
    );
    assert.equal(staged.rowCount, 2);
    assert.ok(staged.rows.every((row) => row.resource_kind === "bin_assets"));
    assert.ok(staged.rows.every((row) => row.status === "previewed"));
    assert.ok(staged.rows.every((row) => row.actor_operator_id === ACTOR.operatorId));
    for (const row of staged.rows) {
      const normalized = normalizeRegistration({
        asset: row.normalized_payload.asset,
        initialState: row.normalized_payload.initialState
      });
      assert.deepEqual(normalized.asset, row.normalized_payload.asset);
      assert.equal(normalized.initialState.occurredAt.toISOString(), row.normalized_payload.initialState.occurredAt);
    }
    const sideEffects = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_audit_events WHERE actor_operator_id = $1) AS audits,
         (SELECT count(*)::int FROM mbt_command_receipts WHERE actor_operator_id = $1) AS receipts`,
      [ACTOR.operatorId]
    );
    assert.deepEqual(sideEffects.rows[0], { audits: 0, receipts: 0 });
  }));
});

test("P3-F11 CSV apply: all rows atomically gain opening ledger/state evidence and exact retry is quiet", async () => {
  await inRollback(() => withAssetManagementEnabled(async () => {
    const previewImport = requiredOperation(service, "previewMbtBinAssetCsvImport");
    const applyImport = requiredOperation(service, "applyMbtBinAssetCsvImport");
    const preview = await previewImport(previewInput("APPLY"));
    const input = applyInput(preview);
    const first = await applyImport(input);
    const replay = await applyImport(structuredClone(input));
    assert.equal(first.status, 201);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
    assert.equal(first.body.schemaVersion, "mbt-bin-assets-import-apply-v1");
    assert.deepEqual(first.body.summary, { created: 2 });
    assert.equal(first.body.items.length, 2);

    const assetCodes = preview.rows.map((row) => row.assetCode);
    const evidence = await query(
      `SELECT asset.asset_code, asset.revision::int AS asset_revision,
              movement.asset_sequence::int, movement.movement_type, movement.source,
              state.revision::int AS state_revision,
              state.last_movement_id = movement.movement_id AS linked
         FROM mbt_bin_assets asset
         JOIN mbt_bin_movements movement USING (asset_id)
         JOIN mbt_bin_asset_state state USING (asset_id)
        WHERE asset.asset_code = ANY($1::text[])
        ORDER BY asset.asset_code`,
      [assetCodes]
    );
    assert.equal(evidence.rowCount, 2);
    assert.ok(evidence.rows.every((row) => row.asset_revision === 1));
    assert.ok(evidence.rows.every((row) => row.asset_sequence === 1));
    assert.ok(evidence.rows.every((row) => row.movement_type === "asset_registered"));
    assert.ok(evidence.rows.every((row) => row.source === "asset_csv_import"));
    assert.ok(evidence.rows.every((row) => row.state_revision === 1 && row.linked === true));

    const durable = await query(
      `SELECT
         (SELECT status FROM mbt_import_batches WHERE batch_id = $2) AS batch_status,
         (SELECT count(*)::int FROM mbt_import_apply_results WHERE batch_id = $2) AS results,
         (SELECT count(*)::int FROM mbt_audit_events WHERE actor_operator_id = $1) AS audits,
         (SELECT count(*)::int FROM mbt_command_receipts WHERE actor_operator_id = $1) AS receipts`,
      [ACTOR.operatorId, preview.batchId]
    );
    assert.deepEqual(durable.rows[0], {
      batch_status: "applied",
      results: 2,
      audits: 3,
      receipts: 3
    });
  }));
});

test("P3-F11 CSV apply: failure injection rolls back assets, rows, receipts, audits, and batch state", async () => {
  await inRollback(() => withAssetManagementEnabled(async () => {
    const previewImport = requiredOperation(service, "previewMbtBinAssetCsvImport");
    const applyImport = requiredOperation(service, "applyMbtBinAssetCsvImport");
    const preview = await previewImport(previewInput("ROLLBACK"));
    const injected = new Error("synthetic asset CSV row failure");
    await assert.rejects(
      () => applyImport(applyInput(preview, {
        hooks: {
          afterAssetRegistration({ rowNumber }) {
            if (rowNumber === 2) {
              throw injected;
            }
          }
        }
      })),
      (error) => error === injected
    );
    const evidence = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_bin_assets WHERE asset_code = ANY($1::text[])) AS assets,
         (SELECT count(*)::int FROM mbt_import_apply_results WHERE batch_id = $2) AS results,
         (SELECT status FROM mbt_import_batches WHERE batch_id = $2) AS batch_status,
         (SELECT count(*)::int FROM mbt_audit_events WHERE actor_operator_id = $3) AS audits,
         (SELECT count(*)::int FROM mbt_command_receipts WHERE actor_operator_id = $3) AS receipts`,
      [preview.rows.map((row) => row.assetCode), preview.batchId, ACTOR.operatorId]
    );
    assert.deepEqual(evidence.rows[0], {
      assets: 0,
      results: 0,
      batch_status: "previewed",
      audits: 0,
      receipts: 0
    });
  }));
});

test("P3-F11 CSV boundaries: role, closed gate, hash, ownership, expiry, and changed retry fail closed", async () => {
  await inRollback(async () => {
    const previewImport = requiredOperation(service, "previewMbtBinAssetCsvImport");
    const applyImport = requiredOperation(service, "applyMbtBinAssetCsvImport");
    await assert.rejects(
      () => previewImport({
        ...previewInput("ROLE"),
        actor: { operatorId: "asset-csv-dispatcher", roles: ["dispatcher"] }
      }),
      (error) => error?.status === 403 && error?.code === "MBT_ADMIN_REQUIRED"
    );
    const rootBefore = config.mbt.enabled;
    config.mbt.enabled = false;
    try {
      await assert.rejects(
        () => previewImport(previewInput("GATE")),
        (error) => error?.status === 409 && error?.code === "MBT_CAPABILITY_DISABLED"
      );
    } finally {
      config.mbt.enabled = rootBefore;
    }

    await withAssetManagementEnabled(async () => {
      const preview = await previewImport(previewInput("BOUNDARY"));
      await assert.rejects(
        () => applyImport(applyInput(preview, { normalizedHash: "0".repeat(64) })),
        (error) => error?.status === 409 && error?.code === "MBT_IMPORT_HASH_MISMATCH"
      );
      await assert.rejects(
        () => applyImport(applyInput(preview, {
          actor: { operatorId: "other-asset-admin", roles: ["admin"] }
        })),
        (error) => error?.status === 404 && error?.code === "MBT_IMPORT_BATCH_NOT_FOUND"
      );
      await query(
        `UPDATE mbt_import_batches
            SET previewed_at = now() - interval '2 seconds',
                expires_at = now() - interval '1 second'
          WHERE batch_id = $1`,
        [preview.batchId]
      );
      await assert.rejects(
        () => applyImport(applyInput(preview)),
        (error) => error?.status === 409 && error?.code === "MBT_IMPORT_BATCH_EXPIRED"
      );

      const changedPreview = await previewImport(previewInput("IDEMPOTENCY"));
      const exact = applyInput(changedPreview);
      await applyImport(exact);
      await assert.rejects(
        () => applyImport({ ...exact, reason: "Changed reason under same key" }),
        (error) => error?.status === 409 && error?.code === "MBT_IDEMPOTENCY_CONFLICT"
      );
    });
  });
});

test("P3-F11 CSV conflicts: inactive/unknown references, stale snapshots, and duplicate targets are explicit", async () => {
  await inRollback(() => withAssetManagementEnabled(async () => {
    const previewImport = requiredOperation(service, "previewMbtBinAssetCsvImport");
    const applyImport = requiredOperation(service, "applyMbtBinAssetCsvImport");
    const unknown = previewInput("UNKNOWN");
    unknown.content = unknown.content.replaceAll(",14YD,", ",NO_SUCH_BIN_TYPE,");
    await assert.rejects(
      () => previewImport(unknown),
      (error) => error?.status === 400 && error?.code === "MBT_ASSET_REFERENCE_INVALID"
    );

    const stale = await previewImport(previewInput("STALE"));
    await query(
      "UPDATE mbt_bin_types SET revision = revision + 1 WHERE type_code = '14YD'"
    );
    await assert.rejects(
      () => applyImport(applyInput(stale)),
      (error) => error?.status === 409 && error?.code === "MBT_ASSET_IMPORT_STALE_REVISION"
    );

    const first = await previewImport(previewInput("DUPLICATE"));
    await applyImport(applyInput(first));
    await assert.rejects(
      () => previewImport({ ...previewInput("OTHER"), content: first.rows.length
        ? buildAssetCsvFile({
          rows: first.rows.map((row) => ({
            asset_code: row.assetCode,
            qr_code: row.qrCode || "",
            barcode: row.barcode || "",
            bin_type_code: row.binTypeCode,
            home_yard_code: row.homeYardCode,
            tare_weight_kg: row.tareWeightKg || "",
            condition_code: row.conditionCode || "",
            operational_notes: row.operationalNotes,
            active: String(row.active),
            under_maintenance: String(row.underMaintenance),
            initial_lifecycle_status: row.initialLifecycleStatus,
            initial_location_kind: row.initialLocationKind,
            initial_location_identity: row.initialLocationIdentity || "",
            initial_location_reference: row.initialLocationReference || "",
            occurred_at: row.occurredAt
          }))
        }).content
        : "" }),
      (error) => error?.status === 409 && error?.code === "MBT_ASSET_DUPLICATE"
    );
  }));
});
