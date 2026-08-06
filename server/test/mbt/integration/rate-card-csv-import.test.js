// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { buildRateCardCsvFiles } from "../support/rate-card-csv-import-fixtures.js";

const SERVICE_PATH = "../../../src/mbt/" + "rate-card-csv-import-service.js";
const service = /** @type {Record<string, Function>} */ (await import(SERVICE_PATH).catch(() => ({})));
const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({ operatorId: `p36-csv-${RUN_ID}`, roles: Object.freeze(["admin"]) });
let sequence = 0;

after(async () => {
  await closeDb();
});

/** @param {string} name */
function requiredOperation(name) {
  const operation = service[name];
  assert.equal(typeof operation, "function", `P3.6a requires rate-card-csv-import-service.${name}.`);
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

function previewInput(suffix) {
  sequence += 1;
  return {
    actor: ACTOR,
    files: buildRateCardCsvFiles({ suffix, minimal: true }),
    correlationId: `p36-csv-preview-corr-${RUN_ID}-${sequence}`,
    requestId: `p36-csv-preview-req-${RUN_ID}-${sequence}`
  };
}

function applyInput(preview, extra = {}) {
  sequence += 1;
  return {
    actor: ACTOR,
    batchId: preview.batchId,
    normalizedHash: preview.normalizedHash,
    targetRevisionToken: preview.targetRevisionToken,
    reason: "Apply synthetic five-file rate graph",
    idempotencyKey: `p36-csv-apply-${RUN_ID}-${sequence}`,
    correlationId: `p36-csv-apply-corr-${RUN_ID}-${sequence}`,
    requestId: `p36-csv-apply-req-${RUN_ID}-${sequence}`,
    ...extra
  };
}

/** @param {string} rateCardCode @param {{outboxBaseline?: number}} [options] */
async function domainCounts(rateCardCode, { outboxBaseline = 0 } = {}) {
  const result = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_rate_cards WHERE rate_card_code = $1) AS cards,
       (SELECT count(*)::int FROM mbt_rate_card_versions version
         JOIN mbt_rate_cards card USING (rate_card_id)
        WHERE card.rate_card_code = $1) AS versions,
       (SELECT count(*)::int FROM mbt_rate_distance_bands band
         JOIN mbt_rate_card_versions version USING (rate_card_version_id)
         JOIN mbt_rate_cards card USING (rate_card_id)
        WHERE card.rate_card_code = $1) AS bands,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox`
    , [rateCardCode]
  );
  return {
    ...result.rows[0],
    outbox: Number(result.rows[0].outbox) - outboxBaseline
  };
}

test("P3-F12 CSV preview: only private staged evidence changes before apply", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const previewRateCardCsvImport = requiredOperation("previewRateCardCsvImport");
    const input = previewInput("PREVIEW");
    const code = "P36CSV_PREVIEW";
    const before = await domainCounts(code);
    const preview = await previewRateCardCsvImport(input);
    assert.equal(preview.schemaVersion, "mbt-rate-card-import-preview-v1");
    assert.equal(preview.status, "previewed");
    assert.equal(preview.graph.rateCard.rateCardCode, code);
    assert.deepEqual(preview.summary.rowsByFile, {
      rate_cards: 1,
      distance_bands: 2,
      components: 0,
      dump_tariffs: 0,
      deposit_rules: 0
    });
    assert.match(preview.batchId, /^[0-9a-f-]{36}$/);
    assert.match(preview.normalizedHash, /^[0-9a-f]{64}$/);
    assert.match(preview.targetRevisionToken, /^[0-9a-f]{64}$/);
    assert.deepEqual(await domainCounts(code), before);
    const evidence = await query(
      `SELECT batch.resource_kind, batch.status,
              count(staged.row_number)::int AS staged,
              bool_and(staged.normalized_payload ? 'rateCard') AS graph_only
         FROM mbt_import_batches batch
         JOIN mbt_import_staged_rows staged USING (batch_id)
        WHERE batch.batch_id = $1
        GROUP BY batch.batch_id`,
      [preview.batchId]
    );
    assert.deepEqual(evidence.rows, [{
      resource_kind: "rate_cards",
      status: "previewed",
      staged: 1,
      graph_only: true
    }]);
    const commandEvidence = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_audit_events WHERE actor_operator_id = $1) AS audits,
         (SELECT count(*)::int FROM mbt_command_receipts WHERE actor_operator_id = $1) AS receipts`,
      [ACTOR.operatorId]
    );
    assert.deepEqual(commandEvidence.rows[0], { audits: 0, receipts: 0 });
  }));
});

test("P3-F12 CSV apply: one transaction creates the graph and exact retry is side-effect free", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const previewRateCardCsvImport = requiredOperation("previewRateCardCsvImport");
    const applyRateCardCsvImport = requiredOperation("applyRateCardCsvImport");
    const preview = await previewRateCardCsvImport(previewInput("APPLY"));
    const outboxBaseline = (await domainCounts("P36CSV_APPLY")).outbox;
    const input = applyInput(preview);
    const first = await applyRateCardCsvImport(input);
    const replay = await applyRateCardCsvImport(structuredClone(input));
    assert.equal(first.status, 201);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
    assert.equal(first.body.schemaVersion, "mbt-rate-card-import-apply-v1");
    assert.equal(first.body.status, "applied");
    assert.equal(first.body.version.status, "draft");
    assert.deepEqual(await domainCounts("P36CSV_APPLY", { outboxBaseline }), {
      cards: 1,
      versions: 1,
      bands: 2,
      outbox: 0
    });
    const evidence = await query(
      `SELECT
         (SELECT status FROM mbt_import_batches WHERE batch_id = $2) AS batch_status,
         (SELECT count(*)::int FROM mbt_audit_events WHERE actor_operator_id = $1) AS audits,
         (SELECT count(*)::int FROM mbt_command_receipts WHERE actor_operator_id = $1) AS receipts`,
      [ACTOR.operatorId, preview.batchId]
    );
    assert.deepEqual(evidence.rows[0], { batch_status: "applied", audits: 2, receipts: 2 });
  }));
});

test("P3-F12 CSV apply: a failure after nested draft creation rolls back every boundary", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const previewRateCardCsvImport = requiredOperation("previewRateCardCsvImport");
    const applyRateCardCsvImport = requiredOperation("applyRateCardCsvImport");
    const preview = await previewRateCardCsvImport(previewInput("ROLLBACK"));
    const outboxBaseline = (await domainCounts("P36CSV_ROLLBACK")).outbox;
    const injected = new Error("synthetic post-draft failure");
    await assert.rejects(
      () => applyRateCardCsvImport(applyInput(preview, {
        hooks: { afterDraftApply() { throw injected; } }
      })),
      (error) => error === injected
    );
    assert.deepEqual(await domainCounts("P36CSV_ROLLBACK", { outboxBaseline }), {
      cards: 0,
      versions: 0,
      bands: 0,
      outbox: 0
    });
    const evidence = await query(
      `SELECT
         (SELECT status FROM mbt_import_batches WHERE batch_id = $2) AS batch_status,
         (SELECT count(*)::int FROM mbt_audit_events WHERE actor_operator_id = $1) AS audits,
         (SELECT count(*)::int FROM mbt_command_receipts WHERE actor_operator_id = $1) AS receipts`,
      [ACTOR.operatorId, preview.batchId]
    );
    assert.deepEqual(evidence.rows[0], { batch_status: "previewed", audits: 0, receipts: 0 });
  }));
});

test("P3-F12 CSV boundaries: Admin, gate, hash, ownership, and expiry fail closed", async () => {
  await inRollback(async () => {
    const previewRateCardCsvImport = requiredOperation("previewRateCardCsvImport");
    const applyRateCardCsvImport = requiredOperation("applyRateCardCsvImport");
    await assert.rejects(
      () => previewRateCardCsvImport({
        ...previewInput("ROLE"),
        actor: { operatorId: "not-admin", roles: ["dispatcher"] }
      }),
      (error) => error?.status === 403 && error?.code === "MBT_ADMIN_REQUIRED"
    );
    const environmentBefore = config.mbt.enabled;
    config.mbt.enabled = false;
    try {
      await assert.rejects(
        () => previewRateCardCsvImport(previewInput("GATE")),
        (error) => error?.status === 409 && error?.code === "MBT_CAPABILITY_DISABLED"
      );
    } finally {
      config.mbt.enabled = environmentBefore;
    }

    await withMasterDataEnabled(async () => {
      const preview = await previewRateCardCsvImport(previewInput("BOUND"));
      await assert.rejects(
        () => applyRateCardCsvImport(applyInput(preview, { normalizedHash: "0".repeat(64) })),
        (error) => error?.status === 409 && error?.code === "MBT_IMPORT_HASH_MISMATCH"
      );
      await assert.rejects(
        () => applyRateCardCsvImport(applyInput(preview, {
          actor: { operatorId: "other-admin", roles: ["admin"] }
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
        () => applyRateCardCsvImport(applyInput(preview)),
        (error) => error?.status === 409 && error?.code === "MBT_IMPORT_BATCH_EXPIRED"
      );
    });
  });
});
