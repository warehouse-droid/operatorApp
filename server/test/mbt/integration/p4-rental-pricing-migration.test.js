import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  createTemporaryMigrationDatabase,
  dropTemporaryMigrationDatabase,
  runOfficialMigrationRunner
} from "../../support/migration-upgrade.mjs";

const { Client } = pg;

test("P4-R1 migration upgrades protected rentals without excluding custom local items", async () => {
  const temporary = await createTemporaryMigrationDatabase({ databaseUrl: process.env.DATABASE_URL || "" });
  try {
    const migrated = await runOfficialMigrationRunner({ databaseUrl: temporary.databaseUrl });
    assert.equal(migrated.exitCode, 0, migrated.stderr);
    const client = new Client({ connectionString: temporary.databaseUrl });
    await client.connect();
    try {
      const protectedRows = await client.query(
        `SELECT item_code, pricing_mode FROM mbt_local_item_settings
          WHERE item_code = ANY($1::text[]) ORDER BY item_code`,
        [["14YD", "20YD", "40YD"]]
      );
      assert.deepEqual(protectedRows.rows, [
        { item_code: "14YD", pricing_mode: "rental_item" },
        { item_code: "20YD", pricing_mode: "rental_item" },
        { item_code: "40YD", pricing_mode: "rental_item" }
      ]);
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO mbt_bin_types (
           bin_type_id, type_code, display_name, nominal_yards,
           local_item_code, active, created_by, updated_by
         ) VALUES (
           '00000000-0000-4000-8000-000000009999'::uuid,
           'CUSTOM_RENTAL_TEST', 'Custom rental test', 50,
           'CUSTOM_RENTAL_TEST', true, 'test', 'test'
         )`
      );
      await client.query(
        `INSERT INTO mbt_local_item_settings (
           item_code, display_name, description, item_type, rental_period_days,
           category, bin_type_id, pricing_mode,
           netsuite_mapping_local_key, system_owned, applicable_service_types,
           applicable_legacy_source_types, active, revision, created_by, updated_by
         ) VALUES (
           'CUSTOM_RENTAL_TEST', 'Custom rental test', '', 'bin', 14,
           'bin_charge', '00000000-0000-4000-8000-000000009999'::uuid, 'rental_item',
           NULL, false, ARRAY['delivery']::text[], ARRAY[]::text[], true, 1, 'test', 'test'
         )`
      );
      await client.query("COMMIT");
      const custom = await client.query(
        `SELECT system_owned, item_type, rental_period_days, pricing_mode
           FROM mbt_local_item_settings WHERE item_code = 'CUSTOM_RENTAL_TEST'`
      );
      assert.deepEqual(custom.rows, [{
        system_owned: false,
        item_type: "bin",
        rental_period_days: 14,
        pricing_mode: "rental_item"
      }]);
    } finally {
      await client.end();
    }
  } finally {
    await dropTemporaryMigrationDatabase(temporary);
  }
});
