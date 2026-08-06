// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { canonicalSha256 } from "../../../src/mbt/canonical-json.js";
import {
  applyRateCardCsvImport,
  previewRateCardCsvImport
} from "../../../src/mbt/rate-card-csv-import-service.js";
import { applyLocalRateCardDraft } from "../../../src/mbt/rate-card-configuration-service.js";
import { buildRateCardCsvFiles } from "../support/rate-card-csv-import-fixtures.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({ operatorId: `p36-csv-hard-${RUN_ID}`, roles: Object.freeze(["admin"]) });
let sequence = 0;

after(async () => {
  await closeDb();
});

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
async function withMasterDataEnabled(operation) {
  const before = { root: config.mbt.enabled, masterData: config.mbtPhase3.masterDataEnabled };
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  await query(
    `UPDATE mbt_feature_flags SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
  );
  try {
    return await operation();
  } finally {
    config.mbt.enabled = before.root;
    config.mbtPhase3.masterDataEnabled = before.masterData;
  }
}

/** @param {string} suffix @param {Record<string, unknown>} [extra] */
function previewInput(suffix, extra = {}) {
  sequence += 1;
  return {
    actor: ACTOR,
    files: buildRateCardCsvFiles({ suffix, minimal: true }),
    correlationId: `p36-csv-hard-preview-corr-${RUN_ID}-${sequence}`,
    requestId: `p36-csv-hard-preview-req-${RUN_ID}-${sequence}`,
    ...extra
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
    reason: "Apply hardened five-file graph",
    idempotencyKey: `p36-csv-hard-apply-${RUN_ID}-${sequence}`,
    correlationId: `p36-csv-hard-apply-corr-${RUN_ID}-${sequence}`,
    requestId: `p36-csv-hard-apply-req-${RUN_ID}-${sequence}`,
    ...extra
  };
}

/** @param {() => Promise<unknown>} operation @param {string} code @param {number} [status] */
async function rejectsCode(operation, code, status = 400) {
  await assert.rejects(
    operation,
    (error) => error?.status === status && error?.code === code,
    code
  );
}

test("P3-F12 CSV service hardening: malformed actors and command identities fail closed", async () => {
  await inRollback(async () => {
    for (const actor of [null, [], { operatorId: "", roles: ["admin"] }, { operatorId: "operator", roles: "admin" }]) {
      await rejectsCode(
        () => previewRateCardCsvImport(previewInput("ACTOR", { actor })),
        "MBT_ADMIN_REQUIRED",
        403
      );
    }

    await withMasterDataEnabled(async () => {
      await rejectsCode(
        () => previewRateCardCsvImport(previewInput("CORR", { correlationId: "" })),
        "MBT_CORRELATION_ID_REQUIRED"
      );
      await rejectsCode(
        () => previewRateCardCsvImport(previewInput("REQUEST", { requestId: "" })),
        "MBT_REQUEST_ID_REQUIRED"
      );
      const preview = await previewRateCardCsvImport(previewInput("IDENTITY", {
        actor: { operatorId: ACTOR.operatorId, roles: ["ADMIN", ""] }
      }));
      await rejectsCode(
        () => applyRateCardCsvImport(applyInput(preview, { batchId: "" })),
        "MBT_IMPORT_BATCH_REQUIRED"
      );
      await rejectsCode(
        () => applyRateCardCsvImport(applyInput(preview, { normalizedHash: "invalid" })),
        "MBT_IMPORT_HASH_MISMATCH"
      );
      await rejectsCode(
        () => applyRateCardCsvImport(applyInput(preview, { targetRevisionToken: "invalid" })),
        "MBT_IMPORT_STALE_REVISION"
      );
      const withoutEnteredReason = await applyRateCardCsvImport(
        applyInput(preview, { reason: "" })
      );
      assert.equal(withoutEnteredReason.replayed, false);
    });
  });
});

test("P3-F12 CSV service hardening: stored status, target, staged row, and staged hash remain authoritative", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const staleToken = await previewRateCardCsvImport(previewInput("TOKEN"));
    await query(
      "UPDATE mbt_import_batches SET target_revision_token = $2 WHERE batch_id = $1",
      [staleToken.batchId, "0".repeat(64)]
    );
    await rejectsCode(
      () => applyRateCardCsvImport(applyInput(staleToken)),
      "MBT_IMPORT_STALE_REVISION",
      409
    );

    const failed = await previewRateCardCsvImport(previewInput("STATUS"));
    await query("UPDATE mbt_import_batches SET status = 'failed' WHERE batch_id = $1", [failed.batchId]);
    await rejectsCode(
      () => applyRateCardCsvImport(applyInput(failed)),
      "MBT_IMPORT_BATCH_NOT_APPLICABLE",
      409
    );

    const missing = await previewRateCardCsvImport(previewInput("MISSING"));
    await query("DELETE FROM mbt_import_staged_rows WHERE batch_id = $1", [missing.batchId]);
    await rejectsCode(
      () => applyRateCardCsvImport(applyInput(missing)),
      "MBT_IMPORT_BATCH_NOT_APPLICABLE",
      409
    );

    const changed = await previewRateCardCsvImport(previewInput("HASH"));
    await query(
      "UPDATE mbt_import_staged_rows SET payload_hash = $2 WHERE batch_id = $1",
      [changed.batchId, "0".repeat(64)]
    );
    await rejectsCode(
      () => applyRateCardCsvImport(applyInput(changed)),
      "MBT_IMPORT_HASH_MISMATCH",
      409
    );
  }));
});

test("P3-F12 CSV service hardening: changed targets and draft failures cannot bypass preview identity", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const changedTarget = await previewRateCardCsvImport(previewInput("TARGET"));
    sequence += 1;
    await applyLocalRateCardDraft({
      actor: ACTOR,
      sourceKind: "csv",
      graph: changedTarget.graph,
      reason: "Create a synthetic target after preview",
      idempotencyKey: `p36-csv-hard-direct-${RUN_ID}-${sequence}`,
      correlationId: `p36-csv-hard-direct-corr-${RUN_ID}-${sequence}`,
      requestId: `p36-csv-hard-direct-req-${RUN_ID}-${sequence}`
    });
    await rejectsCode(
      () => applyRateCardCsvImport(applyInput(changedTarget)),
      "MBT_IMPORT_STALE_REVISION",
      409
    );
    await rejectsCode(
      () => previewRateCardCsvImport(previewInput("TARGET")),
      "MBT_RATE_CARD_EXISTS",
      409
    );

    const invalidReference = await previewRateCardCsvImport(previewInput("REFERENCE"));
    const invalidGraph = structuredClone(invalidReference.graph);
    invalidGraph.rateCard.serviceTemplateCode = "MISSING_TEMPLATE";
    const invalidHash = canonicalSha256(invalidGraph);
    await query(
      `UPDATE mbt_import_batches SET normalized_hash = $2 WHERE batch_id = $1`,
      [invalidReference.batchId, invalidHash]
    );
    await query(
      `UPDATE mbt_import_staged_rows
          SET normalized_payload = $2::jsonb, payload_hash = $3
        WHERE batch_id = $1`,
      [invalidReference.batchId, JSON.stringify(invalidGraph), invalidHash]
    );
    await rejectsCode(
      () => applyRateCardCsvImport(applyInput(invalidReference, { normalizedHash: invalidHash })),
      "MBT_MASTER_REFERENCE_INVALID"
    );
  }));
});

test("P3-F12 CSV service hardening: database target conflicts translate without partial evidence", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const preview = await previewRateCardCsvImport(previewInput("CONFLICT"));
    await query(`
      CREATE FUNCTION pg_temp.p36_rate_card_conflict() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'synthetic target conflict' USING ERRCODE = '23514';
      END
      $$
    `);
    await query(`
      CREATE TRIGGER p36_rate_card_conflict
      BEFORE INSERT ON mbt_rate_cards
      FOR EACH ROW EXECUTE FUNCTION pg_temp.p36_rate_card_conflict()
    `);
    await rejectsCode(
      () => applyRateCardCsvImport(applyInput(preview)),
      "MBT_IMPORT_TARGET_CONFLICT",
      409
    );
    const evidence = await query(
      `SELECT status,
              (SELECT count(*)::int FROM mbt_rate_cards WHERE rate_card_code = $2) AS cards
         FROM mbt_import_batches WHERE batch_id = $1`,
      [preview.batchId, preview.graph.rateCard.rateCardCode]
    );
    assert.deepEqual(evidence.rows[0], { status: "previewed", cards: 0 });
  }));
});
