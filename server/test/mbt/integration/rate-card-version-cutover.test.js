// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { activateLocalRateCardVersion } from "../../../src/mbt/rate-card-configuration-service.js";

const ACTOR = Object.freeze({
  operatorId: `rate-cutover-${crypto.randomUUID()}`,
  roles: Object.freeze(["admin"])
});

after(async () => {
  await closeDb();
});

function command(rateCardVersionId, replacesRateCardVersionId) {
  const identity = crypto.randomUUID();
  return {
    actor: ACTOR,
    rateCardVersionId,
    replacesRateCardVersionId,
    expectedRevision: 1,
    reason: "Replace the current MBBS rate version without a billing gap",
    idempotencyKey: `rate-cutover-${identity}`,
    correlationId: `rate-cutover-correlation-${identity}`,
    requestId: `rate-cutover-request-${identity}`
  };
}

async function seedVersion(rateCardId, versionNumber) {
  const versionId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       effective_from, validation_snapshot, revision, created_by, updated_by
     ) VALUES (
       $1, $2, $3, 'draft', '2026-01-01T00:00:00Z',
       '{"valid":true}'::jsonb, 1, $4, $4
     )`,
    [versionId, rateCardId, versionNumber, ACTOR.operatorId]
  );
  await query(
    `INSERT INTO mbt_rate_distance_bands (
       rate_distance_band_id, rate_card_version_id, service_code,
       sequence_number, minimum_metres, maximum_metres,
       amount_minor, currency, downtown_surcharge_minor, description
     ) VALUES ($1, $2, 'delivery', 0, 0, NULL, $3, 'CAD', 0, $4)`,
    [crypto.randomUUID(), versionId, 10_000 + versionNumber, `Cutover v${versionNumber}`]
  );
  return versionId;
}

test("a validated v2 atomically retires the explicitly expected used v1", async () => {
  const rollback = await beginRollbackContext();
  const environmentBefore = {
    root: config.mbt.enabled,
    masterData: config.mbtPhase3.masterDataEnabled
  };
  try {
    await rollback.run(async () => {
      config.mbt.enabled = true;
      config.mbtPhase3.masterDataEnabled = true;
      await query(
        `UPDATE mbt_feature_flags
            SET enabled = true, updated_by = $2, updated_at = now()
          WHERE flag_key = ANY($1::text[])`,
        [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
      );

      const rateCardId = crypto.randomUUID();
      await query(
        `INSERT INTO mbt_rate_cards (
           rate_card_id, rate_card_code, display_name, currency,
           active, revision, created_by, updated_by
         ) VALUES ($1, $2, 'Cutover regression rate', 'CAD', false, 1, $3, $3)`,
        [rateCardId, `CUTOVER_${crypto.randomUUID().replaceAll("-", "")}`, ACTOR.operatorId]
      );
      const v1 = await seedVersion(rateCardId, 1);
      const v2 = await seedVersion(rateCardId, 2);
      const usedEntityId = crypto.randomUUID();
      await query(
        `UPDATE mbt_rate_card_versions
            SET status = 'active', activated_at = now()
          WHERE rate_card_version_id = $1`,
        [v1]
      );
      await query(
        `UPDATE mbt_rate_card_versions
            SET first_used_at = now(),
                first_used_entity_type = 'billing',
                first_used_entity_id = $2
          WHERE rate_card_version_id = $1`,
        [v1, usedEntityId]
      );
      const sourceBandBefore = await query(
        `SELECT md5(jsonb_agg(to_jsonb(band) ORDER BY band.sequence_number)::text) AS checksum
           FROM mbt_rate_distance_bands band
          WHERE band.rate_card_version_id = $1`,
        [v1]
      );

      const result = await activateLocalRateCardVersion(command(v2, v1));
      assert.equal(result.body.version.rateCardVersionId, v2);
      assert.equal(result.body.version.status, "active");
      assert.equal(result.body.replacedRateCardVersionId, v1);

      const stored = await query(
        `SELECT version.rate_card_version_id::text AS version_id,
                version.status, version.revision::int,
                version.effective_to, version.activated_at, version.retired_at,
                version.first_used_entity_id::text,
                card.active AS card_active
           FROM mbt_rate_card_versions version
           JOIN mbt_rate_cards card USING (rate_card_id)
          WHERE version.rate_card_id = $1
          ORDER BY version.version_number`,
        [rateCardId]
      );
      assert.equal(stored.rows[0].version_id, v1);
      assert.equal(stored.rows[0].status, "retired");
      assert.equal(stored.rows[0].revision, 2);
      assert.ok(stored.rows[0].effective_to instanceof Date);
      assert.ok(stored.rows[0].retired_at instanceof Date);
      assert.equal(stored.rows[0].first_used_entity_id, usedEntityId);
      assert.equal(stored.rows[1].version_id, v2);
      assert.equal(stored.rows[1].status, "active");
      assert.equal(stored.rows[1].revision, 2);
      assert.ok(stored.rows[1].activated_at instanceof Date);
      assert.ok(stored.rows.every((row) => row.card_active === true));
      assert.equal(stored.rows.filter((row) => row.status === "active").length, 1);

      const sourceBandAfter = await query(
        `SELECT md5(jsonb_agg(to_jsonb(band) ORDER BY band.sequence_number)::text) AS checksum
           FROM mbt_rate_distance_bands band
          WHERE band.rate_card_version_id = $1`,
        [v1]
      );
      assert.equal(sourceBandAfter.rows[0].checksum, sourceBandBefore.rows[0].checksum);
      await assert.rejects(
        () => query(
          "UPDATE mbt_rate_card_versions SET calculation_notes = 'forged' WHERE rate_card_version_id = $1",
          [v1]
        ),
        (error) => error?.code === "55000"
      );
    });
  } finally {
    config.mbt.enabled = environmentBefore.root;
    config.mbtPhase3.masterDataEnabled = environmentBefore.masterData;
    await rollback.rollback();
  }
});

test("a stale replacement identity cannot retire the current version or enable the card", async () => {
  const rollback = await beginRollbackContext();
  const environmentBefore = {
    root: config.mbt.enabled,
    masterData: config.mbtPhase3.masterDataEnabled
  };
  try {
    await rollback.run(async () => {
      config.mbt.enabled = true;
      config.mbtPhase3.masterDataEnabled = true;
      await query(
        `UPDATE mbt_feature_flags
            SET enabled = true, updated_by = $2, updated_at = now()
          WHERE flag_key = ANY($1::text[])`,
        [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
      );

      const rateCardId = crypto.randomUUID();
      await query(
        `INSERT INTO mbt_rate_cards (
           rate_card_id, rate_card_code, display_name, currency,
           active, revision, created_by, updated_by
         ) VALUES ($1, $2, 'Stale cutover regression rate', 'CAD', false, 1, $3, $3)`,
        [rateCardId, `STALE_${crypto.randomUUID().replaceAll("-", "")}`, ACTOR.operatorId]
      );
      const v1 = await seedVersion(rateCardId, 1);
      const v2 = await seedVersion(rateCardId, 2);
      await query(
        `UPDATE mbt_rate_card_versions
            SET status = 'active', activated_at = now()
          WHERE rate_card_version_id = $1`,
        [v1]
      );

      await assert.rejects(
        () => activateLocalRateCardVersion(command(v2, crypto.randomUUID())),
        (error) => error?.status === 409 && error?.code === "MBT_RATE_ACTIVE_CONFLICT"
      );
      const stored = await query(
        `SELECT version.status, version.revision::int, card.active AS card_active
           FROM mbt_rate_card_versions version
           JOIN mbt_rate_cards card USING (rate_card_id)
          WHERE version.rate_card_id = $1
          ORDER BY version.version_number`,
        [rateCardId]
      );
      assert.deepEqual(stored.rows, [
        { status: "active", revision: 1, card_active: false },
        { status: "draft", revision: 1, card_active: false }
      ]);
    });
  } finally {
    config.mbt.enabled = environmentBefore.root;
    config.mbtPhase3.masterDataEnabled = environmentBefore.masterData;
    await rollback.rollback();
  }
});

test("a failed successor activation rolls back the retirement and parent enablement", async () => {
  const rollback = await beginRollbackContext();
  const environmentBefore = {
    root: config.mbt.enabled,
    masterData: config.mbtPhase3.masterDataEnabled
  };
  try {
    await rollback.run(async () => {
      config.mbt.enabled = true;
      config.mbtPhase3.masterDataEnabled = true;
      await query(
        `UPDATE mbt_feature_flags
            SET enabled = true, updated_by = $2, updated_at = now()
          WHERE flag_key = ANY($1::text[])`,
        [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
      );

      const rateCardId = crypto.randomUUID();
      await query(
        `INSERT INTO mbt_rate_cards (
           rate_card_id, rate_card_code, display_name, currency,
           active, revision, created_by, updated_by
         ) VALUES ($1, $2, 'Atomic rollback regression rate', 'CAD', false, 1, $3, $3)`,
        [rateCardId, `ROLLBACK_${crypto.randomUUID().replaceAll("-", "")}`, ACTOR.operatorId]
      );
      const v1 = await seedVersion(rateCardId, 1);
      const v2 = await seedVersion(rateCardId, 2);
      await query(
        `UPDATE mbt_rate_card_versions
            SET status = 'active', activated_at = now()
          WHERE rate_card_version_id = $1`,
        [v1]
      );
      await query("DELETE FROM mbt_rate_distance_bands WHERE rate_card_version_id = $1", [v2]);

      await assert.rejects(
        () => activateLocalRateCardVersion(command(v2, v1)),
        (error) => error?.code === "23514"
      );
      const stored = await query(
        `SELECT version.status, version.revision::int, version.retired_at,
                card.active AS card_active
           FROM mbt_rate_card_versions version
           JOIN mbt_rate_cards card USING (rate_card_id)
          WHERE version.rate_card_id = $1
          ORDER BY version.version_number`,
        [rateCardId]
      );
      assert.deepEqual(stored.rows, [
        { status: "active", revision: 1, retired_at: null, card_active: false },
        { status: "draft", revision: 1, retired_at: null, card_active: false }
      ]);
    });
  } finally {
    config.mbt.enabled = environmentBefore.root;
    config.mbtPhase3.masterDataEnabled = environmentBefore.masterData;
    await rollback.rollback();
  }
});
