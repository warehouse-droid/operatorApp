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
const CUSTOMER_BASE = 8_100_000_000_000n
  + ((BigInt(`0x${RUN_ID.slice(0, 12)}`) % 1_000_000_000n) * 100n);
const ACTOR = Object.freeze({
  operatorId: `p3-import-race-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
const RACE_REPETITIONS = 25;
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

/** @param {string} id @param {string} name @param {string} exportedAt */
async function previewCustomer(id, name, exportedAt) {
  const { previewMasterDataImport } = await futureImportService();
  const marker = identity("race-preview");
  return previewMasterDataImport({
    actor: ACTOR,
    resource: "customers",
    sourceKind: "netsuite_spreadsheetml",
    fileName: `${marker}.xls`,
    content: Buffer.from(buildCustomerSpreadsheetMl([
      syntheticCustomerRow({ id, Name: name })
    ])),
    defaults: { ...CUSTOMER_IMPORT_DEFAULTS, exportedAt },
    correlationId: `${marker}-correlation`,
    requestId: `${marker}-request`
  });
}

/** @param {Record<string, unknown>} preview @param {string} key */
async function applyCustomer(preview, key) {
  const { applyMasterDataImport } = await futureImportService();
  return applyMasterDataImport({
    actor: ACTOR,
    resource: "customers",
    batchId: preview.batchId,
    normalizedHash: preview.normalizedHash,
    targetRevisionToken: preview.targetRevisionToken,
    reason: "Concurrent synthetic import",
    idempotencyKey: key,
    correlationId: `${key}-correlation`,
    requestId: `${key}-request`
  });
}

after(async () => {
  await closeDb();
});

test("P3-F07 concurrency: 25 independent two-batch races yield one winner and one stale loser", {
  timeout: 120_000
}, async () => {
  const id = customerId(1);
  const beforeOutbox = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
    const exportedAt = new Date(Date.UTC(2026, 7, 3, 13, iteration, 0)).toISOString();
    const names = [
      `Synthetic Race ${iteration} Left`,
      `Synthetic Race ${iteration} Right`
    ];
    const previews = await Promise.all(names.map((name) => previewCustomer(id, name, exportedAt)));
    assert.equal(previews[0].targetRevisionToken, previews[1].targetRevisionToken);

    const outcomes = await Promise.allSettled(previews.map((preview, side) => (
      applyCustomer(preview, identity(`race-${iteration}-${side}`))
    )));
    const winners = outcomes.filter(({ status }) => status === "fulfilled");
    const losers = outcomes.filter(({ status }) => status === "rejected");
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(losers.length, 1, JSON.stringify(outcomes));
    assert.equal(hasCode(losers[0].reason, "MBT_IMPORT_STALE_REVISION"), true);
    assert.equal(winners[0].value.body.counts.created, iteration === 0 ? 1 : 0);
    assert.equal(winners[0].value.body.counts.updated, iteration === 0 ? 0 : 1);

    const current = await query(
      "SELECT legal_name, source_modified_at FROM netsuite_customers WHERE netsuite_id = $1",
      [id]
    );
    assert.equal(current.rowCount, 1);
    assert.equal(names.includes(current.rows[0].legal_name), true);
    assert.equal(new Date(current.rows[0].source_modified_at).toISOString(), exportedAt);
  }

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM netsuite_customers WHERE netsuite_id = $1) AS customers,
       (SELECT count(*)::int FROM mbt_import_apply_results WHERE entity_id = $1::text) AS apply_results,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox_rows`,
    [id]
  );
  assert.equal(evidence.rows[0].customers, 1);
  assert.equal(evidence.rows[0].apply_results, RACE_REPETITIONS);
  assert.equal(evidence.rows[0].outbox_rows, beforeOutbox.rows[0].count);
});

test("P3-F07 concurrency: simultaneous exact retries share one receipt and one apply result", {
  timeout: 30_000
}, async () => {
  const id = customerId(2);
  const preview = await previewCustomer(
    id,
    "Synthetic Exact Retry Race",
    "2026-08-03T15:00:00.000Z"
  );
  const key = identity("same-command");
  const outcomes = await Promise.all([
    applyCustomer(preview, key),
    applyCustomer(preview, key)
  ]);
  assert.deepEqual(outcomes.map(({ replayed }) => replayed).sort(), [false, true]);
  assert.deepEqual(outcomes[1].body, outcomes[0].body);

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM netsuite_customers WHERE netsuite_id = $1) AS customers,
       (SELECT count(*)::int FROM mbt_import_apply_results WHERE batch_id = $2) AS apply_results,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $3
           AND command_name = 'mbt.import.customers.apply'
           AND idempotency_key = $4) AS receipts`,
    [id, preview.batchId, ACTOR.operatorId, key]
  );
  assert.deepEqual(evidence.rows[0], { customers: 1, apply_results: 1, receipts: 1 });
});
