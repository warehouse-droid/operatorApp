// @ts-check

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import * as dispatchSetupRepository from "../../../src/dispatch-setup-repository.js";

const P3_MASTER_MIGRATION = "112_mbt_p3_shared_dispatch_master_data.sql";
const SHARED_YARDS = Object.freeze([
  Object.freeze({
    code: "12441",
    locationId: 15,
    address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
    latitude: "43.948694",
    longitude: "-79.372758"
  }),
  Object.freeze({
    code: "3445",
    locationId: 1,
    address: "3445 Kennedy Road, Toronto, ON",
    latitude: "43.8204306",
    longitude: "-79.3053423"
  }),
  Object.freeze({
    code: "2967",
    locationId: 28,
    address: "2967 Kennedy Road, Toronto, ON",
    latitude: "43.806119",
    longitude: "-79.2986377"
  }),
  Object.freeze({
    code: "150",
    locationId: 26,
    address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada",
    latitude: null,
    longitude: null
  })
]);

after(async () => {
  await closeDb();
});

test("P3-F10: migration 112 projects the four established Dispatch own yards exactly once", async () => {
  const migration = await query(
    "SELECT filename FROM schema_migrations WHERE filename = $1",
    [P3_MASTER_MIGRATION]
  );
  assert.deepEqual(migration.rows, [{ filename: P3_MASTER_MIGRATION }]);

  const result = await query(
    `SELECT yard_id::text AS yard_id,
            yard_code,
            dispatch_location_id,
            display_name,
            address_line_1,
            timezone,
            latitude::text AS latitude,
            longitude::text AS longitude,
            active
       FROM mbt_yards
      WHERE dispatch_location_id = ANY($1::integer[])
         OR yard_code = ANY($2::text[])
      ORDER BY CASE yard_code
        WHEN '12441' THEN 1
        WHEN '3445' THEN 2
        WHEN '2967' THEN 3
        WHEN '150' THEN 4
        ELSE 99 END`,
    [SHARED_YARDS.map(({ locationId }) => locationId), SHARED_YARDS.map(({ code }) => code)]
  );
  assert.equal(result.rowCount, 4, "A Dispatch yard must never be duplicated under its other identity.");
  assert.equal(new Set(result.rows.map(({ yard_id: yardId }) => yardId)).size, 4);
  assert.ok(result.rows.every(({ yard_id: yardId }) => (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(yardId)
  )));
  assert.deepEqual(result.rows.map((row) => ({
    code: row.yard_code,
    locationId: row.dispatch_location_id,
    displayName: row.display_name,
    address: row.address_line_1,
    timezone: row.timezone,
    latitude: row.latitude,
    longitude: row.longitude,
    active: row.active
  })), SHARED_YARDS.map((yard) => ({
    ...yard,
    displayName: yard.code,
    timezone: "America/Toronto",
    active: true
  })));
});

test("P3-F10: yard code and positive Dispatch location ID are independent unique identities", async () => {
  const columns = await query(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mbt_yards'
        AND column_name IN ('yard_id', 'yard_code', 'dispatch_location_id')
      ORDER BY column_name`
  );
  assert.deepEqual(columns.rows, [
    { column_name: "dispatch_location_id", is_nullable: "NO" },
    { column_name: "yard_code", is_nullable: "NO" },
    { column_name: "yard_id", is_nullable: "NO" }
  ]);

  const definitions = await query(
    `SELECT contype, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'mbt_yards'::regclass
      ORDER BY conname`
  );
  const contract = definitions.rows.map(({ contype, definition }) => `${contype}: ${definition}`).join("\n");
  assert.match(contract, /UNIQUE \(yard_code\)/i);
  assert.match(contract, /UNIQUE \(dispatch_location_id\)/i);
  assert.match(contract, /dispatch_location_id[^\n]*> 0/i);

  await assert.rejects(
    () => query(
      `INSERT INTO mbt_yards (
         yard_id, yard_code, dispatch_location_id, display_name
       ) VALUES (
         '00000000-0000-4000-8000-00000000f101', 'P3-DUPLICATE-LOCATION', 15,
         'must not create a second yard identity'
       )`
    ),
    (error) => error?.code === "23505"
  );
});

test("P3-F10: the shared yard registry has no competing Dispatch or MBT yard table", async () => {
  const duplicates = await query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [["dispatch_own_yards", "mbt_dispatch_yards", "mbt_own_yards", "mbt_asset_yards"]]
  );
  assert.deepEqual(duplicates.rows, []);

  const references = await query(
    `SELECT source.relname AS source_table,
            target.relname AS target_table
       FROM pg_constraint constraint_row
       JOIN pg_class source ON source.oid = constraint_row.conrelid
       JOIN pg_class target ON target.oid = constraint_row.confrelid
      WHERE constraint_row.contype = 'f'
        AND source.relname = ANY($1::text[])
        AND target.relname = 'mbt_yards'
      ORDER BY source.relname`,
    [["mbt_bin_assets", "mbt_bin_asset_state", "mbt_bin_movements", "dispatch_trucks"]]
  );
  assert.deepEqual(
    [...new Set(references.rows.map(({ source_table: sourceTable }) => sourceTable))],
    ["dispatch_trucks", "mbt_bin_asset_state", "mbt_bin_assets", "mbt_bin_movements"]
  );
});

test("P3-F10: Dispatch setup projects relational yards through the unchanged legacy ownYards shape", async () => {
  assert.equal(
    typeof dispatchSetupRepository.listDispatchOwnYards,
    "function",
    "Dispatch setup must read its ownYards projection from the shared relational repository."
  );
  const ownYards = await dispatchSetupRepository.listDispatchOwnYards({ activeOnly: true });
  const selected = SHARED_YARDS.map(({ code }) => {
    const yard = ownYards.find((candidate) => candidate.code === code);
    assert.ok(yard, `Missing Dispatch ownYards projection for ${code}.`);
    return yard;
  });
  assert.deepEqual(selected, [
    {
      code: "12441",
      name: "12441",
      locationId: 15,
      address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
      lat: 43.948694,
      lng: -79.372758
    },
    {
      code: "3445",
      name: "3445",
      locationId: 1,
      address: "3445 Kennedy Road, Toronto, ON",
      lat: 43.8204306,
      lng: -79.3053423
    },
    {
      code: "2967",
      name: "2967",
      locationId: 28,
      address: "2967 Kennedy Road, Toronto, ON",
      lat: 43.806119,
      lng: -79.2986377
    },
    {
      code: "150",
      name: "150",
      locationId: 26,
      address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada"
    }
  ]);
  assert.ok(selected.every((yard) => !Object.hasOwn(yard, "yardId")), "Legacy setup must not confuse UUID and location ID.");
});
