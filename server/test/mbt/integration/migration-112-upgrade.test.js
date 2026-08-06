// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import {
  applyRootMigrationsThrough,
  createTemporaryMigrationDatabase,
  dropTemporaryMigrationDatabase
} from "../../support/migration-upgrade.mjs";

const { Client } = pg;
const PRE_112_MIGRATIONS = Object.freeze([
  "102_mbt_authorities_flags_audit.sql",
  "103_netsuite_customer_master_foundation.sql",
  "104_mbt_assets_templates_fleet.sql",
  "105_mbt_rates_contracts_visits.sql",
  "106_mbt_billing_outbox.sql",
  "107_mbt_netsuite_mappings_preflight.sql",
  "108_mbt_netsuite_sandbox_readiness.sql",
  "109_mbt_local_first_configuration.sql",
  "110_mbt_p3_feature_gates_imports.sql",
  "111_mbt_p3_customer_sync_mirror.sql"
]);
const MIGRATION_112 = "112_mbt_p3_shared_dispatch_master_data.sql";

/** @param {import("pg").Client} client @param {string} filename @param {boolean} record */
async function applyMigration(client, filename, record = true) {
  const sql = await readFile(new URL(`../../../migrations/${filename}`, import.meta.url), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    if (record) {
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** @param {import("pg").Client} client */
async function applySchema111(client) {
  await applyRootMigrationsThrough(client, { through: 101 });
  for (const filename of PRE_112_MIGRATIONS) {
    await applyMigration(client, filename);
  }
}

/** @param {import("pg").Client} client */
async function seedLegacyTruck(client) {
  const truck = await client.query(
    `INSERT INTO dispatch_trucks (
       plate, capacity_lbs, travel_time_percent, display_order, active,
       base_yard, bin_service_enabled, bin_slot_capacity, created_at, updated_at
     ) VALUES (
       'P3-112-UPGRADE-TRUCK', 51750.25, 6.750, 19, true,
       '3445', true, 3, '2026-08-03T01:02:03Z', '2026-08-03T01:02:03Z'
     )
     RETURNING id::text AS id`,
    []
  );
  await client.query(
    `INSERT INTO dispatch_truck_bin_types (
       truck_id, bin_type_id, active, created_by,
       created_at, updated_at
     )
     SELECT $1, bin_type_id, true, 'p3-112-upgrade-test',
            '2026-08-03T01:03:04Z', '2026-08-03T01:03:04Z'
       FROM mbt_bin_types
      WHERE type_code = '14YD'`,
    [truck.rows[0].id]
  );
  return String(truck.rows[0].id);
}

/** @param {import("pg").Client} client @param {string} truckId */
async function legacyChecksum(client, truckId) {
  const result = await client.query(
    `SELECT md5(to_jsonb(selected)::text) AS checksum
       FROM (
         SELECT id::text AS id, plate, capacity_lbs, travel_time_percent,
                display_order, active, base_yard, created_at
           FROM dispatch_trucks
          WHERE id = $1
       ) selected`,
    [truckId]
  );
  assert.equal(result.rowCount, 1, "The pre-112 legacy truck fixture must exist exactly once.");
  return String(result.rows[0].checksum);
}

/** @param {import("pg").Client} client */
async function phase34DataDigest(client) {
  const result = await client.query(
    `SELECT md5(jsonb_build_array(
       (SELECT jsonb_agg(to_jsonb(yard) ORDER BY yard_code) FROM mbt_yards yard),
       (SELECT jsonb_agg(to_jsonb(item) ORDER BY item_code) FROM mbt_local_item_settings item),
       (SELECT jsonb_agg(to_jsonb(truck) ORDER BY id) FROM dispatch_trucks truck),
       (SELECT jsonb_agg(to_jsonb(size) ORDER BY truck_id, bin_type_id)
          FROM dispatch_truck_bin_types size)
     )::text) AS digest`
  );
  return String(result.rows[0].digest);
}

test("P3-F10: schema-111 upgrade backfills a representative legacy truck once without changing its legacy checksum", {
  timeout: 30_000
}, async () => {
  const temporary = await createTemporaryMigrationDatabase({
    databaseUrl: process.env.DATABASE_URL || ""
  });
  const client = new Client({ connectionString: temporary.databaseUrl });
  await client.connect();
  try {
    await applySchema111(client);
    const truckId = await seedLegacyTruck(client);
    const legacyBefore = await legacyChecksum(client, truckId);

    const preUpgrade = await client.query(
      `SELECT bin_service_enabled, bin_slot_capacity,
              (SELECT count(*)::int
                 FROM dispatch_truck_bin_types supported
                WHERE supported.truck_id = truck.id AND supported.active) AS supported_sizes
         FROM dispatch_trucks truck
        WHERE truck.id = $1`,
      [truckId]
    );
    assert.deepEqual(preUpgrade.rows, [{
      bin_service_enabled: true,
      bin_slot_capacity: 3,
      supported_sizes: 1
    }]);

    await applyMigration(client, MIGRATION_112);
    assert.equal(await legacyChecksum(client, truckId), legacyBefore);
    const upgraded = await client.query(
      `SELECT truck_type, bin_service_enabled, bin_slot_capacity,
              base_yard_id::text AS base_yard_id, revision::int AS revision,
              (SELECT count(*)::int
                 FROM dispatch_truck_bin_types supported
                WHERE supported.truck_id = truck.id AND supported.active) AS supported_sizes
         FROM dispatch_trucks truck
        WHERE truck.id = $1`,
      [truckId]
    );
    assert.deepEqual(upgraded.rows, [{
      truck_type: "flatbed",
      bin_service_enabled: false,
      bin_slot_capacity: 0,
      base_yard_id: null,
      revision: 1,
      supported_sizes: 0
    }]);
    const ledger = await client.query(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      [MIGRATION_112]
    );
    assert.deepEqual(ledger.rows, [{ filename: MIGRATION_112 }]);

    const beforeRerun = await phase34DataDigest(client);
    await applyMigration(client, MIGRATION_112, false);
    assert.equal(
      await phase34DataDigest(client),
      beforeRerun,
      "Executing the exact migration SQL twice must not reset a configured fleet or rewrite evidence."
    );
  } finally {
    await client.end().catch(() => undefined);
    await dropTemporaryMigrationDatabase(temporary);
  }
});
