// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";

const RATE_SERVICE_PATH = "../../../src/mbt/" + "rate-card-configuration-service.js";
const rateService = /** @type {Record<string, Function>} */ (await import(RATE_SERVICE_PATH)
  .catch(() => ({})));
const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const CARD_PREFIX = `P3RACE${RUN_ID.slice(0, 12)}`;
const ACTOR = Object.freeze({
  operatorId: `p3-rate-race-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
const RACE_REPETITIONS = 25;
const originalEnvironment = Object.freeze({
  root: config.mbt.enabled,
  masterData: config.mbtPhase3.masterDataEnabled
});
let commandSequence = 0;
/** @type {Array<{flag_key: string, enabled: boolean, revision: string, updated_by: string | null, updated_at: Date}>} */
let originalFlags = [];

/** @param {string} name */
function requiredOperation(name) {
  const operation = rateService[name];
  assert.equal(typeof operation, "function", `P3.6 requires rate-card-configuration-service.${name}.`);
  return operation;
}

before(async () => {
  const flags = await query(
    `SELECT flag_key, enabled, revision, updated_by, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = ANY($1::text[])
      ORDER BY flag_key`,
    [["mbt_enabled", "mbt_master_data"]]
  );
  assert.equal(flags.rowCount, 2);
  originalFlags = flags.rows;
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
  );
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
});

after(async () => {
  for (const flag of originalFlags) {
    await query(
      `UPDATE mbt_feature_flags
          SET enabled = $2, revision = $3, updated_by = $4, updated_at = $5
        WHERE flag_key = $1`,
      [flag.flag_key, flag.enabled, flag.revision, flag.updated_by, flag.updated_at]
    ).catch(() => undefined);
  }
  config.mbt.enabled = originalEnvironment.root;
  config.mbtPhase3.masterDataEnabled = originalEnvironment.masterData;
  await closeDb();
});

/** @param {string} label @param {number} versionCount */
async function seedDrafts(label, versionCount) {
  const rateCardId = crypto.randomUUID();
  const rateCardCode = `${CARD_PREFIX}${label}`;
  await query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, currency,
       active, revision, created_by, updated_by
     ) VALUES ($1, $2, $3, 'CAD', true, 1, $4, $4)`,
    [rateCardId, rateCardCode, `P3.6 race ${label}`, ACTOR.operatorId]
  );
  const versions = [];
  for (let index = 0; index < versionCount; index += 1) {
    const rateCardVersionId = crypto.randomUUID();
    await query(
      `INSERT INTO mbt_rate_card_versions (
         rate_card_version_id, rate_card_id, version_number, status,
         effective_from, validation_snapshot, revision, created_by, updated_by
       ) VALUES (
         $1, $2, $3, 'draft', '2036-08-03T00:00:00Z',
         '{"valid":true}'::jsonb, 1, $4, $4
       )`,
      [rateCardVersionId, rateCardId, index + 1, ACTOR.operatorId]
    );
    await query(
      `INSERT INTO mbt_rate_distance_bands (
         rate_distance_band_id, rate_card_version_id, service_code,
         sequence_number, minimum_metres, maximum_metres,
         amount_minor, currency, downtown_surcharge_minor, description
       ) VALUES ($1, $2, 'delivery', 0, 0, NULL, 12000, 'CAD', 0, 'P3.6 race')`,
      [crypto.randomUUID(), rateCardVersionId]
    );
    versions.push({ rateCardVersionId, revision: 1 });
  }
  return { rateCardId, rateCardCode, versions };
}

/** @param {string} label @param {Record<string, unknown>} extra @param {string | null} [fixedKey] */
function command(label, extra, fixedKey = null) {
  commandSequence += 1;
  const identity = `${RUN_ID}-${commandSequence}`;
  return {
    actor: ACTOR,
    reason: `P3.6 ${label}`,
    idempotencyKey: fixedKey || `p3-rate-race-idem-${identity}`,
    correlationId: `p3-rate-race-corr-${identity}`,
    requestId: `p3-rate-race-req-${identity}`,
    ...extra
  };
}

test("P3-F12: 25 two-version activation races produce one active winner and one explicit conflict", {
  timeout: 30_000
}, async () => {
  const activateLocalRateCardVersion = requiredOperation("activateLocalRateCardVersion");
  const evidenceBefore = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND action = 'mbt.rate_card.activated') AS audits,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1 AND command_name = 'mbt.rate_card.activate') AS receipts`,
    [ACTOR.operatorId]
  );
  for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
    const seeded = await seedDrafts(`A${String(iteration).padStart(2, "0")}`, 2);
    const outcomes = await Promise.allSettled(seeded.versions.map((version, side) => (
      activateLocalRateCardVersion(command(`activation ${iteration}-${side}`, {
        rateCardVersionId: version.rateCardVersionId,
        expectedRevision: version.revision
      }))
    )));
    const winners = outcomes.filter(({ status }) => status === "fulfilled");
    const losers = outcomes.filter(({ status }) => status === "rejected");
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(losers.length, 1, JSON.stringify(outcomes));
    assert.equal(losers[0].reason?.status, 409);
    assert.equal(losers[0].reason?.code, "MBT_RATE_ACTIVE_CONFLICT");
    const stored = await query(
      `SELECT status, count(*)::int AS count
         FROM mbt_rate_card_versions
        WHERE rate_card_id = $1
        GROUP BY status
        ORDER BY status`,
      [seeded.rateCardId]
    );
    assert.deepEqual(stored.rows, [
      { status: "active", count: 1 },
      { status: "draft", count: 1 }
    ]);
  }
  const evidenceAfter = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND action = 'mbt.rate_card.activated') AS audits,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1 AND command_name = 'mbt.rate_card.activate') AS receipts`,
    [ACTOR.operatorId]
  );
  assert.deepEqual(evidenceAfter.rows[0], {
    audits: evidenceBefore.rows[0].audits + RACE_REPETITIONS,
    receipts: evidenceBefore.rows[0].receipts + RACE_REPETITIONS
  });
});

test("P3-F12: 25 simultaneous exact activation retries retain one revision, audit, and receipt", {
  timeout: 20_000
}, async () => {
  const activateLocalRateCardVersion = requiredOperation("activateLocalRateCardVersion");
  const seeded = await seedDrafts("RETRY", 1);
  const version = seeded.versions[0];
  const idempotencyKey = `p3-rate-exact-retry-${RUN_ID}`;
  const input = command("exact activation retry", {
    rateCardVersionId: version.rateCardVersionId,
    expectedRevision: version.revision
  }, idempotencyKey);
  const outcomes = await Promise.all(Array.from(
    { length: 25 },
    () => activateLocalRateCardVersion(structuredClone(input))
  ));
  assert.equal(outcomes.filter(({ replayed }) => replayed === false).length, 1);
  assert.equal(outcomes.filter(({ replayed }) => replayed === true).length, 24);
  assert.ok(outcomes.every(({ body }) => body.version.status === "active"));
  assert.ok(outcomes.every(({ body }) => (
    body.version.rateCardVersionId === outcomes[0].body.version.rateCardVersionId
      && body.version.revision === outcomes[0].body.version.revision
  )));
  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND action = 'mbt.rate_card.activated'
           AND idempotency_key = $2) AS audits,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1 AND command_name = 'mbt.rate_card.activate'
           AND idempotency_key = $2) AS receipts`,
    [ACTOR.operatorId, idempotencyKey]
  );
  assert.deepEqual(evidence.rows[0], { audits: 1, receipts: 1 });
});
