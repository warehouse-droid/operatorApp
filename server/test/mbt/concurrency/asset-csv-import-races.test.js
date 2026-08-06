// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";
import { buildAssetCsvFile } from "../support/asset-csv-import-fixtures.js";

const SERVICE_PATH = "../../../src/mbt/" + "asset-csv-import-service.js";
const service = /** @type {Record<string, Function>} */ (await import(SERVICE_PATH).catch(() => ({})));
const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({ operatorId: `p35-csv-race-${RUN_ID}`, roles: Object.freeze(["admin"]) });
const environmentBefore = Object.freeze({
  root: config.mbt.enabled,
  assets: config.mbtPhase3.assetManagementEnabled
});
let flagsBefore = [];
let sequence = 0;

/** @param {string} name */
function requiredOperation(name) {
  const operation = service[name];
  assert.equal(typeof operation, "function", `P3.5a requires asset-csv-import-service.${name}.`);
  return operation;
}

before(async () => {
  const flags = await query(
    `SELECT flag_key, enabled, revision, updated_by, updated_at
       FROM mbt_feature_flags WHERE flag_key = ANY($1::text[]) ORDER BY flag_key`,
    [["mbt_enabled", "mbt_asset_management"]]
  );
  flagsBefore = flags.rows;
  await query(
    `UPDATE mbt_feature_flags SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_asset_management"], ACTOR.operatorId]
  );
  config.mbt.enabled = true;
  config.mbtPhase3.assetManagementEnabled = true;
});

after(async () => {
  for (const flag of flagsBefore) {
    await query(
      `UPDATE mbt_feature_flags SET enabled = $2, revision = $3,
         updated_by = $4, updated_at = $5 WHERE flag_key = $1`,
      [flag.flag_key, flag.enabled, flag.revision, flag.updated_by, flag.updated_at]
    ).catch(() => undefined);
  }
  config.mbt.enabled = environmentBefore.root;
  config.mbtPhase3.assetManagementEnabled = environmentBefore.assets;
  await closeDb();
});

/** @param {string} suffix @param {string} [content] */
async function preview(suffix, content) {
  sequence += 1;
  const file = buildAssetCsvFile({ suffix });
  return requiredOperation("previewMbtBinAssetCsvImport")({
    actor: ACTOR,
    content: content ?? file.content,
    fileName: file.fileName,
    correlationId: `p35-csv-race-preview-corr-${RUN_ID}-${sequence}`,
    requestId: `p35-csv-race-preview-req-${RUN_ID}-${sequence}`
  });
}

/** @param {Record<string, any>} result @param {string} idempotencyKey */
function applyInput(result, idempotencyKey) {
  sequence += 1;
  return {
    actor: ACTOR,
    batchId: result.batchId,
    normalizedHash: result.normalizedHash,
    targetRevisionToken: result.targetRevisionToken,
    reason: "P3.5a concurrent asset CSV apply",
    idempotencyKey,
    correlationId: `p35-csv-race-apply-corr-${RUN_ID}-${sequence}`,
    requestId: `p35-csv-race-apply-req-${RUN_ID}-${sequence}`
  };
}

test("P3-F11 CSV race: 25 simultaneous exact retries create two assets once and replay 24", {
  timeout: 30_000
}, async () => {
  const applyImport = requiredOperation("applyMbtBinAssetCsvImport");
  const result = await preview(`RETRY_${RUN_ID.slice(0, 8)}`);
  const input = applyInput(result, `p35-csv-race-exact-${RUN_ID}`);
  const outcomes = await Promise.all(Array.from(
    { length: 25 },
    () => applyImport(structuredClone(input))
  ));
  assert.equal(outcomes.filter(({ replayed }) => replayed === false).length, 1);
  assert.equal(outcomes.filter(({ replayed }) => replayed === true).length, 24);
  assert.ok(outcomes.every(({ body }) => JSON.stringify(body) === JSON.stringify(outcomes[0].body)));
  const stored = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_bin_assets WHERE asset_code = ANY($1::text[])) AS assets,
       (SELECT count(*)::int FROM mbt_bin_movements movement
          JOIN mbt_bin_assets asset USING (asset_id)
         WHERE asset.asset_code = ANY($1::text[])) AS movements,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $2 AND command_name = 'mbt.import.bin_assets.apply'
           AND idempotency_key = $3) AS receipts`,
    [result.rows.map((row) => row.assetCode), ACTOR.operatorId, input.idempotencyKey]
  );
  assert.deepEqual(stored.rows[0], { assets: 2, movements: 2, receipts: 1 });
});

test("P3-F11 CSV race: 25 independent preview/apply competitors have one complete winner", {
  timeout: 45_000
}, async () => {
  const applyImport = requiredOperation("applyMbtBinAssetCsvImport");
  const suffix = `COMPETE_${RUN_ID.slice(0, 8)}`;
  const file = buildAssetCsvFile({ suffix });
  const previews = [];
  for (let index = 0; index < 25; index += 1) {
    previews.push(await preview(`${suffix}_${index}`, file.content));
  }
  const outcomes = await Promise.allSettled(previews.map((result, index) => (
    applyImport(applyInput(result, `p35-csv-race-independent-${RUN_ID}-${index}`))
  )));
  const winners = outcomes.filter(({ status }) => status === "fulfilled");
  const losers = outcomes.filter(({ status }) => status === "rejected");
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, 24, JSON.stringify(outcomes));
  assert.ok(losers.every((outcome) => outcome.reason?.status === 409));
  assert.ok(losers.every((outcome) => [
    "MBT_ASSET_IMPORT_STALE_REVISION",
    "MBT_ASSET_DUPLICATE"
  ].includes(outcome.reason?.code)));
  const stored = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_bin_assets WHERE asset_code = ANY($1::text[])) AS assets,
       (SELECT count(*)::int FROM mbt_bin_movements movement
          JOIN mbt_bin_assets asset USING (asset_id)
         WHERE asset.asset_code = ANY($1::text[])) AS movements,
       (SELECT count(*)::int FROM mbt_import_batches
         WHERE batch_id = ANY($2::uuid[]) AND status = 'applied') AS applied_batches`,
    [previews[0].rows.map((row) => row.assetCode), previews.map(({ batchId }) => batchId)]
  );
  assert.deepEqual(stored.rows[0], { assets: 2, movements: 2, applied_batches: 1 });
});
