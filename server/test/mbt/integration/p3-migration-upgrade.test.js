// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import {
  applyRootMigrationsThrough,
  createTemporaryMigrationDatabase,
  dropTemporaryMigrationDatabase,
  runOfficialMigrationRunner
} from "../../support/migration-upgrade.mjs";

const { Client } = pg;
const MIGRATION = "110_mbt_p3_feature_gates_imports.sql";
const PRE_P3_MIGRATIONS = Object.freeze([
  "102_mbt_authorities_flags_audit.sql",
  "103_netsuite_customer_master_foundation.sql",
  "104_mbt_assets_templates_fleet.sql",
  "105_mbt_rates_contracts_visits.sql",
  "106_mbt_billing_outbox.sql",
  "107_mbt_netsuite_mappings_preflight.sql",
  "108_mbt_netsuite_sandbox_readiness.sql",
  "109_mbt_local_first_configuration.sql"
]);
const NEW_FLAGS = Object.freeze([
  "mbt_asset_management",
  "mbt_customer_sync",
  "mbt_master_data"
]);

async function applySchema109(client) {
  await applyRootMigrationsThrough(client, { through: 101 });
  for (const filename of PRE_P3_MIGRATIONS) {
    const sql = await readFile(new URL(`../../../migrations/${filename}`, import.meta.url), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}

async function seedRepresentativeState(client) {
  await client.query(
    `INSERT INTO operators (
       id, username, display_name, password_hash, password_salt,
       role, roles, yard_location_ids, active
     ) VALUES (
       'p3-upgrade-operator', 'p3-upgrade-operator', 'P3 upgrade operator',
       'test-only-hash', 'test-only-salt', 'admin', ARRAY['admin']::text[],
       ARRAY[]::integer[], true
     )`
  );
  await client.query(
    `INSERT INTO operator_sessions (token_hash, operator_id, expires_at)
     VALUES ('p3-upgrade-token-hash', 'p3-upgrade-operator', '2099-08-03T00:00:00Z')`
  );
  const truck = await client.query(
    `INSERT INTO dispatch_trucks (
       plate, capacity_lbs, travel_time_percent, display_order, active, base_yard
     ) VALUES ('P3-UPGRADE-TRUCK', 48000, 6.5, 8, true, '3445')
     RETURNING id`
  );
  const driver = await client.query(
    `INSERT INTO dispatch_drivers (name, login, active)
     VALUES ('P3 Upgrade Driver', 'p3-upgrade-driver', true)
     RETURNING id`
  );
  const plan = await client.query(
    `INSERT INTO dispatch_plans (plan_date, status, note, revision)
     VALUES ('2099-08-03', 'draft', 'P3 upgrade ordinary plan', 7)
     RETURNING id`
  );
  await client.query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)`,
    [
      plan.rows[0].id,
      JSON.stringify([{ id: "P3-UPGRADE-SO", type: "SO", reference: "P3-UPGRADE-SO" }]),
      JSON.stringify([{
        id: String(truck.rows[0].id),
        driverId: String(driver.rows[0].id),
        loads: [{ id: "P3-UPGRADE-LOAD", orderIds: ["P3-UPGRADE-SO"] }]
      }]),
      JSON.stringify({ totalLoads: 1, source: "p3-upgrade" })
    ]
  );
  await client.query(
    `INSERT INTO scm_transport_schedule (
       order_kind, source_table, source_id, order_ref, display_ref,
       is_special_order, method, pickup_point, dropoff_point, brand, content,
       weight_lbs, status, notes, created_by, updated_by, reconciliation_blocked
     ) VALUES (
       'PO', 'purchase_orders', 9300001, 'P3-UPGRADE-PO', 'P3 Upgrade PO',
       false, 'MBT', '2967', '3445', 'P3 Vendor', 'Keep unrelated SCM MBT',
       12000, 'Hold', 'Preserve exact state', 'p3-upgrade', 'p3-upgrade', false
     )`
  );
}

async function representativeChecksum(client, { includeLocalItems = true } = {}) {
  const result = await client.query(
    `SELECT md5((jsonb_build_object(
       'operator', (SELECT to_jsonb(row_value) FROM (
         SELECT id, username, display_name, role, roles, active
           FROM operators WHERE id = 'p3-upgrade-operator'
       ) row_value),
       'session', (SELECT to_jsonb(row_value) FROM (
         SELECT token_hash, operator_id, expires_at
           FROM operator_sessions WHERE token_hash = 'p3-upgrade-token-hash'
       ) row_value),
       'truck', (SELECT to_jsonb(row_value) FROM (
         SELECT plate, capacity_lbs, travel_time_percent, display_order, active,
                base_yard, bin_service_enabled, bin_slot_capacity
           FROM dispatch_trucks WHERE plate = 'P3-UPGRADE-TRUCK'
       ) row_value),
       'driver', (SELECT to_jsonb(row_value) FROM (
         SELECT name, login, active
           FROM dispatch_drivers WHERE login = 'p3-upgrade-driver'
       ) row_value),
       'plan', (SELECT jsonb_build_object(
         'plan', to_jsonb(plan_row),
         'snapshot', to_jsonb(snapshot_row)
       ) FROM (
         SELECT id, plan_date, status, note, revision
           FROM dispatch_plans WHERE plan_date = '2099-08-03'
       ) plan_row
       JOIN LATERAL (
         SELECT orders, trucks, summary
           FROM dispatch_plan_snapshots WHERE plan_id = plan_row.id
       ) snapshot_row ON true),
       'scm', (SELECT to_jsonb(row_value) FROM (
         SELECT order_kind, source_table, source_id, order_ref, method,
                pickup_point, dropoff_point, status, notes
           FROM scm_transport_schedule WHERE order_ref = 'P3-UPGRADE-PO'
       ) row_value),
       'local_items', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY item_code)
         FROM (
           SELECT item_code, display_name, category, pricing_mode, active
             FROM mbt_local_item_settings
       ) row_value)
     ) - CASE WHEN $1::boolean THEN '__retain_local_items__' ELSE 'local_items' END)::text) AS checksum`,
    [includeLocalItems]
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0].checksum;
}

test("P3.1: the current isolated schema records migration 110 and all new flags closed", async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL || "" });
  await client.connect();
  try {
    const migration = await client.query(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      [MIGRATION]
    );
    assert.deepEqual(migration.rows, [{ filename: MIGRATION }]);
    const flags = await client.query(
      `SELECT flag_key, enabled, revision, NULLIF(btrim(description), '') IS NOT NULL AS described
         FROM mbt_feature_flags
        WHERE flag_key = ANY($1::text[])
        ORDER BY flag_key`,
      [NEW_FLAGS]
    );
    assert.deepEqual(flags.rows.map(({ revision: _revision, ...row }) => row), NEW_FLAGS.map((flagKey) => ({
      flag_key: flagKey,
      enabled: false,
      described: true
    })));
    assert.ok(flags.rows.every(({ revision }) => Number(revision) >= 1));
  } finally {
    await client.end();
  }
});

test("P3.1: fresh application and exact rerun use the official migration runner", async () => {
  const temporary = await createTemporaryMigrationDatabase({ databaseUrl: process.env.DATABASE_URL || "" });
  try {
    const first = await runOfficialMigrationRunner({ databaseUrl: temporary.databaseUrl });
    assert.equal(first.exitCode, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`Applied ${MIGRATION.replace(".", "\\.")}`));

    const second = await runOfficialMigrationRunner({ databaseUrl: temporary.databaseUrl });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(second.stdout.trim(), "", "An exact migration rerun must be a no-op.");

    const client = new Client({ connectionString: temporary.databaseUrl });
    await client.connect();
    try {
      const flags = await client.query(
        `SELECT flag_key, enabled FROM mbt_feature_flags
          WHERE flag_key = ANY($1::text[]) ORDER BY flag_key`,
        [NEW_FLAGS]
      );
      assert.deepEqual(flags.rows, NEW_FLAGS.map((flagKey) => ({ flag_key: flagKey, enabled: false })));
    } finally {
      await client.end();
    }
  } finally {
    await dropTemporaryMigrationDatabase(temporary);
  }
});

test("P3.1: schema-109 upgrade times out atomically and later applies the documented item pricing model", async () => {
  const temporary = await createTemporaryMigrationDatabase({ databaseUrl: process.env.DATABASE_URL || "" });
  const setup = new Client({ connectionString: temporary.databaseUrl });
  const blocker = new Client({ connectionString: temporary.databaseUrl });
  await setup.connect();
  await blocker.connect();
  try {
    await applySchema109(setup);
    await seedRepresentativeState(setup);
    const before = await representativeChecksum(setup);
    const legacyBefore = await representativeChecksum(setup, { includeLocalItems: false });

    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE mbt_feature_flags IN ACCESS EXCLUSIVE MODE");
    const startedAt = Date.now();
    const blocked = await runOfficialMigrationRunner({ databaseUrl: temporary.databaseUrl });
    const elapsedMs = Date.now() - startedAt;
    assert.notEqual(blocked.exitCode, 0, "A blocked migration must fail instead of waiting indefinitely.");
    assert.ok(elapsedMs < 8_000, `The migration lock wait was unbounded: ${elapsedMs}ms.`);

    const notApplied = await setup.query(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      [MIGRATION]
    );
    assert.equal(notApplied.rowCount, 0);
    await blocker.query("ROLLBACK");
    const partialFlags = await setup.query(
      "SELECT flag_key FROM mbt_feature_flags WHERE flag_key = ANY($1::text[])",
      [NEW_FLAGS]
    );
    assert.equal(partialFlags.rowCount, 0, "A timed-out migration must leave no partial flag rows.");
    assert.equal(await representativeChecksum(setup), before);

    const retried = await runOfficialMigrationRunner({ databaseUrl: temporary.databaseUrl });
    assert.equal(retried.exitCode, 0, retried.stderr);
    assert.match(retried.stdout, new RegExp(`Applied ${MIGRATION.replace(".", "\\.")}`));
    assert.equal(
      await representativeChecksum(setup, { includeLocalItems: false }),
      legacyBefore,
      "The successful retry must preserve every representative non-MBT legacy record."
    );
    const localItems = await setup.query(
      `SELECT item_code, pricing_mode
         FROM mbt_local_item_settings
        ORDER BY item_code`
    );
    assert.deepEqual(localItems.rows, [
      { item_code: "14YD", pricing_mode: "rental_item" },
      { item_code: "20YD", pricing_mode: "rental_item" },
      { item_code: "40YD", pricing_mode: "rental_item" },
      { item_code: "DELIVERY_CROSS_CHARGE", pricing_mode: "rate_card" },
      { item_code: "DUMP", pricing_mode: "rate_card" }
    ]);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await Promise.allSettled([setup.end(), blocker.end()]);
    await dropTemporaryMigrationDatabase(temporary);
  }
});
