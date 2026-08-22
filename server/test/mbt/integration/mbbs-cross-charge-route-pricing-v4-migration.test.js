// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";

import pg from "pg";

const ENABLED = process.env.MBT_TEST_ISOLATED === "1"
  && process.env.MBT_CROSS_CHARGE_MIGRATION_CUTOVER_TEST === "1";

test("migration 175 preserves active v3 evidence and atomically activates corrected v4", {
  skip: !ENABLED
}, async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const cardId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO mbt_local_item_settings (
         item_code, display_name, description, item_type, rental_period_days,
         category, bin_type_id, pricing_mode, netsuite_mapping_local_key,
         system_owned, applicable_service_types, applicable_legacy_source_types,
         charge_basis, density_lbs_per_yard, active, revision, created_by, updated_by
       ) VALUES (
         'DELIVERY_CHARGE_MBBS', 'Delivery Charge MBBS', 'Local MBBS delivery charge.',
         'delivery_fee', NULL, 'cross_charge', NULL, 'rate_card',
         'delivery_charge_mbbs', false, ARRAY['delivery']::text[],
         ARRAY['SO','TO','PO','VRMA']::text[], 'distance', NULL, true, 1,
         'migration-v4-test', 'migration-v4-test'
       ) ON CONFLICT (item_code) DO NOTHING`
    );
    await client.query(
      `INSERT INTO mbt_rate_cards (
         rate_card_id, rate_card_code, display_name, currency, created_by, updated_by
       ) VALUES ($1, 'DELIVERY_CHARGE_MBBS', 'Delivery_Charge_MBBS_2026_Rate',
                 'CAD', 'migration-v4-test', 'migration-v4-test')`,
      [cardId]
    );
    await client.query(
      `INSERT INTO mbt_rate_card_versions (
         rate_card_version_id, rate_card_id, version_number, status,
         effective_from, validation_snapshot, created_by, updated_by
       ) VALUES ($1, $2, 3, 'draft', '2026-01-01T00:00:00.000Z',
                 '{"valid":true}'::jsonb, 'migration-v4-test', 'migration-v4-test')`,
      [versionId, cardId]
    );
    await client.query(
      `INSERT INTO mbt_mbbs_rate_card_policies (
         rate_card_version_id, schema_version, currency,
         direct_pickup_unit_amount_minor, po_additional_drop_unit_amount_minor,
         so_charge_basis, to_replenishment_charge_basis,
         to_direct_pickup_charge_basis, po_charge_basis,
         po_additional_drop_basis, dispatch_load_split_basis,
         po_vrma_additional_stop_unit_amount_minor,
         po_vrma_base_charge_basis, vrma_direction_basis,
         po_vrma_additional_stop_basis, endpoint_override_basis,
         revision, created_by, updated_by
       ) VALUES (
         $1, 2, 'CAD', 10000, 10000,
         'per_order_group_as_one', 'full_route_once', 'fixed_unit_once',
         'shared_leg_equal_split', 'each_distinct_drop_after_first',
         'ignored_for_charge', 10000,
         'vendor_yard_pair_then_distance_band', 'same_pair_reverse',
         'each_distinct_stop_after_base_pair',
         'flat_default_user_may_choose_distance', 1,
         'migration-v4-test', 'migration-v4-test')`,
      [versionId]
    );
    const bands = [
      [0, 0, 30_000, 23_500, "flat"],
      [1, 30_000, 50_000, 28_498, "flat"],
      [2, 50_000, 65_000, 33_500, "flat"],
      [3, 65_000, 75_000, 38_500, "flat"],
      [4, 75_000, null, 700, "per_km"]
    ];
    for (const [sequence, minimum, maximum, amount, basis] of bands) {
      await client.query(
        `INSERT INTO mbt_rate_distance_bands (
           rate_distance_band_id, rate_card_version_id, item_code,
           service_code, bin_type_id, sequence_number, minimum_metres,
           maximum_metres, amount_minor, pricing_basis, boundary_rule,
           origin_yard_codes, currency, downtown_surcharge_minor, description
         ) VALUES ($1, $2, 'DELIVERY_CHARGE_MBBS', 'mbbs_cross_charge', NULL,
                   $3, $4, $5, $6, $7, 'upper_inclusive', ARRAY[]::text[],
                   'CAD', 0, 'migration v4 cutover fixture')`,
        [crypto.randomUUID(), versionId, sequence, minimum, maximum, amount, basis]
      );
    }
    await client.query(
      `UPDATE mbt_rate_card_versions
          SET status = 'active', activated_at = now(), revision = revision + 1
        WHERE rate_card_version_id = $1`,
      [versionId]
    );
    await client.query(
      "DELETE FROM schema_migrations WHERE filename = '175_mbt_mbbs_cross_charge_route_pricing_v4.sql'"
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }

  const migrated = spawnSync(process.execPath, ["src/migrate.js"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8"
  });
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
  assert.match(migrated.stdout, /Applied 175_mbt_mbbs_cross_charge_route_pricing_v4\.sql/u);

  const verify = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await verify.connect();
  try {
    const versions = await verify.query(
      `SELECT version.version_number::int, version.status,
              policy.schema_version::int,
              policy.to_replenishment_additional_drop_unit_amount_minor::int AS to_drop_minor,
              policy.to_replenishment_multi_drop_basis AS to_drop_basis
         FROM mbt_rate_card_versions version
         JOIN mbt_mbbs_rate_card_policies policy USING (rate_card_version_id)
        WHERE version.rate_card_id = $1
        ORDER BY version.version_number`,
      [cardId]
    );
    assert.deepEqual(versions.rows, [
      {
        version_number: 3,
        status: "retired",
        schema_version: 2,
        to_drop_minor: null,
        to_drop_basis: null
      },
      {
        version_number: 4,
        status: "active",
        schema_version: 3,
        to_drop_minor: 10_000,
        to_drop_basis: "longest_origin_drop_plus_each_distinct_drop_after_first"
      }
    ]);
    const retainedAndCorrected = await verify.query(
      `SELECT version.version_number::int,
              band.minimum_metres::int, band.maximum_metres::int,
              band.amount_minor::int, band.base_amount_minor::int,
              band.included_metres::int
         FROM mbt_rate_card_versions version
         JOIN mbt_rate_distance_bands band USING (rate_card_version_id)
        WHERE version.rate_card_id = $1
          AND band.sequence_number IN (1, 4)
        ORDER BY version.version_number, band.sequence_number`,
      [cardId]
    );
    assert.deepEqual(retainedAndCorrected.rows, [
      { version_number: 3, minimum_metres: 30_000, maximum_metres: 50_000, amount_minor: 28_498, base_amount_minor: null, included_metres: null },
      { version_number: 3, minimum_metres: 75_000, maximum_metres: null, amount_minor: 700, base_amount_minor: null, included_metres: null },
      { version_number: 4, minimum_metres: 30_000, maximum_metres: 50_000, amount_minor: 28_500, base_amount_minor: null, included_metres: null },
      { version_number: 4, minimum_metres: 75_000, maximum_metres: null, amount_minor: 700, base_amount_minor: 38_500, included_metres: 75_000 }
    ]);
  } finally {
    await verify.end();
  }

  const idempotent = spawnSync(process.execPath, ["src/migrate.js"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8"
  });
  assert.equal(idempotent.status, 0, idempotent.stderr || idempotent.stdout);
  assert.doesNotMatch(idempotent.stdout, /Applied 175_/u);
});
