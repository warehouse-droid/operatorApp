// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";
import { buildRateCardCsvFiles } from "../support/rate-card-csv-import-fixtures.js";

const SERVICE_PATH = "../../../src/mbt/" + "rate-card-csv-import-service.js";
const service = /** @type {Record<string, Function>} */ (await import(SERVICE_PATH).catch(() => ({})));
const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({ operatorId: `p36-csv-race-${RUN_ID}`, roles: Object.freeze(["admin"]) });
const environmentBefore = Object.freeze({ root: config.mbt.enabled, masterData: config.mbtPhase3.masterDataEnabled });
let flagsBefore = [];
let sequence = 0;

/** @param {string} name */
function requiredOperation(name) {
  const operation = service[name];
  assert.equal(typeof operation, "function", `P3.6a requires rate-card-csv-import-service.${name}.`);
  return operation;
}

before(async () => {
  const flags = await query(
    `SELECT flag_key, enabled, revision, updated_by, updated_at
       FROM mbt_feature_flags WHERE flag_key = ANY($1::text[]) ORDER BY flag_key`,
    [["mbt_enabled", "mbt_master_data"]]
  );
  flagsBefore = flags.rows;
  await query(
    `UPDATE mbt_feature_flags SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
  );
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
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
  config.mbtPhase3.masterDataEnabled = environmentBefore.masterData;
  await closeDb();
});

async function preview(suffix) {
  sequence += 1;
  return requiredOperation("previewRateCardCsvImport")({
    actor: ACTOR,
    files: buildRateCardCsvFiles({ suffix, minimal: true }),
    correlationId: `p36-csv-race-preview-corr-${RUN_ID}-${sequence}`,
    requestId: `p36-csv-race-preview-req-${RUN_ID}-${sequence}`
  });
}

function applyInput(result, idempotencyKey) {
  sequence += 1;
  return {
    actor: ACTOR,
    batchId: result.batchId,
    normalizedHash: result.normalizedHash,
    targetRevisionToken: result.targetRevisionToken,
    reason: "P3.6a concurrent CSV apply",
    idempotencyKey,
    correlationId: `p36-csv-race-apply-corr-${RUN_ID}-${sequence}`,
    requestId: `p36-csv-race-apply-req-${RUN_ID}-${sequence}`
  };
}

test("P3-F12 CSV race: 25 simultaneous exact retries create one draft and replay 24", {
  timeout: 20_000
}, async () => {
  const applyRateCardCsvImport = requiredOperation("applyRateCardCsvImport");
  const result = await preview(`RETRY${RUN_ID.slice(0, 6)}`);
  const input = applyInput(result, `p36-csv-race-exact-${RUN_ID}`);
  const outcomes = await Promise.all(Array.from(
    { length: 25 },
    () => applyRateCardCsvImport(structuredClone(input))
  ));
  assert.equal(outcomes.filter(({ replayed }) => replayed === false).length, 1);
  assert.equal(outcomes.filter(({ replayed }) => replayed === true).length, 24);
  assert.ok(outcomes.every(({ body }) => body.version.rateCardVersionId === outcomes[0].body.version.rateCardVersionId));
  const stored = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_rate_cards WHERE rate_card_code = $1) AS cards,
       (SELECT count(*)::int FROM mbt_import_batches WHERE batch_id = $2 AND status = 'applied') AS applied,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $3 AND command_name = 'mbt.import.rate_cards.apply'
           AND idempotency_key = $4) AS receipts`,
    [result.graph.rateCard.rateCardCode, result.batchId, ACTOR.operatorId, input.idempotencyKey]
  );
  assert.deepEqual(stored.rows[0], { cards: 1, applied: 1, receipts: 1 });
});

test("P3-F12 CSV race: independent apply keys have one winner and one explicit batch conflict", async () => {
  const applyRateCardCsvImport = requiredOperation("applyRateCardCsvImport");
  const result = await preview(`COMPETE${RUN_ID.slice(0, 6)}`);
  const outcomes = await Promise.allSettled([
    applyRateCardCsvImport(applyInput(result, `p36-csv-race-left-${RUN_ID}`)),
    applyRateCardCsvImport(applyInput(result, `p36-csv-race-right-${RUN_ID}`))
  ]);
  const winners = outcomes.filter(({ status }) => status === "fulfilled");
  const losers = outcomes.filter(({ status }) => status === "rejected");
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, 1, JSON.stringify(outcomes));
  assert.equal(losers[0].reason?.status, 409);
  assert.equal(losers[0].reason?.code, "MBT_IMPORT_BATCH_NOT_APPLICABLE");
  const stored = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_rate_cards WHERE rate_card_code = $1) AS cards,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $2 AND entity_id IN ($3, $4)) AS audits
    `,
    [
      result.graph.rateCard.rateCardCode,
      ACTOR.operatorId,
      result.batchId,
      winners[0].value.body.version.rateCardVersionId
    ]
  );
  assert.deepEqual(stored.rows[0], { cards: 1, audits: 2 });
});
