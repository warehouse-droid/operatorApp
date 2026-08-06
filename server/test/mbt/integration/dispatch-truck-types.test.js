// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";
import {
  listDispatchTrucks,
  replaceDispatchFleetSetup
} from "../../../src/dispatch-setup-repository.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase();
const PLATE_PREFIX = `P3T${RUN_ID}`;

after(async () => {
  await withTransaction(async () => {
    await query(
      `DELETE FROM dispatch_truck_bin_types
        WHERE truck_id IN (SELECT id FROM dispatch_trucks WHERE plate LIKE $1)`,
      [`${PLATE_PREFIX}%`]
    );
    await query("DELETE FROM dispatch_trucks WHERE plate LIKE $1", [`${PLATE_PREFIX}%`]);
  }).catch(() => undefined);
  await closeDb();
});

async function referenceIds() {
  const result = await query(
    `SELECT
       (SELECT yard_id::text FROM mbt_yards WHERE yard_code = '3445') AS yard_id,
       (SELECT bin_type_id::text FROM mbt_bin_types WHERE type_code = '14YD') AS bin_type_id`
  );
  assert.match(String(result.rows[0]?.yard_id || ""), /^[0-9a-f-]{36}$/i);
  assert.match(String(result.rows[0]?.bin_type_id || ""), /^[0-9a-f-]{36}$/i);
  return result.rows[0];
}

async function insertValidBinTruck(suffix = "BIN") {
  const { yard_id: yardId, bin_type_id: binTypeId } = await referenceIds();
  return withTransaction(async () => {
    const inserted = await query(
      `INSERT INTO dispatch_trucks (
         plate, capacity_lbs, travel_time_percent, base_yard, active,
         truck_type, bin_service_enabled, bin_slot_capacity, base_yard_id
       ) VALUES ($1, 52000, 7.5, '3445', true, 'bin', true, 2, $2)
       RETURNING id::text AS id, revision::int AS revision`,
      [`${PLATE_PREFIX}-${suffix}`, yardId]
    );
    await query(
      `INSERT INTO dispatch_truck_bin_types (truck_id, bin_type_id, active, created_by)
       VALUES ($1, $2, true, 'p3-truck-type-test')`,
      [inserted.rows[0].id, binTypeId]
    );
    return inserted.rows[0];
  });
}

test("P3-F10: migration 112 leaves every fresh-schema truck in explicit Flatbed capability", async () => {
  const migration = await query(
    `SELECT applied_at
       FROM schema_migrations
      WHERE filename = '112_mbt_p3_shared_dispatch_master_data.sql'`
  );
  assert.equal(migration.rowCount, 1);

  const columns = await query(
    `SELECT column_name, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'dispatch_trucks'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [["base_yard_id", "bin_service_enabled", "bin_slot_capacity", "revision", "truck_type"]]
  );
  assert.equal(columns.rowCount, 5, JSON.stringify(columns.rows));
  const truckType = columns.rows.find(({ column_name: name }) => name === "truck_type");
  assert.equal(truckType?.is_nullable, "NO");
  assert.match(String(truckType?.column_default || ""), /flatbed/i);

  const legacy = await query(
    `SELECT truck.id::text AS id,
            truck.plate,
            truck.truck_type,
            truck.bin_service_enabled,
            truck.bin_slot_capacity,
            count(supported.bin_type_id)::int AS supported_sizes
       FROM dispatch_trucks truck
       LEFT JOIN dispatch_truck_bin_types supported
         ON supported.truck_id = truck.id
        AND supported.active
      WHERE truck.created_at <= $1
      GROUP BY truck.id
      ORDER BY truck.id`,
    [migration.rows[0].applied_at]
  );
  assert.ok(legacy.rows.every((truck) => (
    truck.truck_type === "flatbed"
      && truck.bin_service_enabled === false
      && truck.bin_slot_capacity === 0
      && truck.supported_sizes === 0
  )), JSON.stringify(legacy.rows));
});

test("P3-F10: database invariants keep truck type, compatibility flag, slots, base yard, and sizes coherent", async () => {
  const constraints = await query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid IN ('dispatch_trucks'::regclass, 'dispatch_truck_bin_types'::regclass)
      ORDER BY conname`
  );
  const definitions = constraints.rows.map(({ definition }) => definition).join("\n");
  assert.match(definitions, /truck_type[^\n]*(?:flatbed[^\n]*bin|bin[^\n]*flatbed)/i);
  assert.match(definitions, /bin_service_enabled[^\n]*truck_type/i);
  assert.match(definitions, /bin_slot_capacity/i);
  assert.match(definitions, /base_yard_id/i);
  assert.match(definitions, /revision[^\n]*> 0/i);

  const { yard_id: yardId, bin_type_id: binTypeId } = await referenceIds();
  const invalidCommands = [
    () => query(
      `INSERT INTO dispatch_trucks (
         plate, truck_type, bin_service_enabled, bin_slot_capacity, base_yard_id
       ) VALUES ($1, 'flatbed', true, 0, NULL)`,
      [`${PLATE_PREFIX}-BAD-FLAG`]
    ),
    () => query(
      `INSERT INTO dispatch_trucks (
         plate, truck_type, bin_service_enabled, bin_slot_capacity, base_yard_id
       ) VALUES ($1, 'flatbed', false, 1, NULL)`,
      [`${PLATE_PREFIX}-BAD-SLOT`]
    ),
    () => query(
      `INSERT INTO dispatch_trucks (
         plate, truck_type, bin_service_enabled, bin_slot_capacity, base_yard_id
       ) VALUES ($1, 'bin', true, 0, $2)`,
      [`${PLATE_PREFIX}-BAD-ZERO`, yardId]
    ),
    () => query(
      `INSERT INTO dispatch_trucks (
         plate, truck_type, bin_service_enabled, bin_slot_capacity, base_yard_id
       ) VALUES ($1, 'bin', true, 1, NULL)`,
      [`${PLATE_PREFIX}-BAD-YARD`]
    )
  ];
  for (const invalid of invalidCommands) {
    await assert.rejects(invalid, (error) => ["23514", "23502", "55000"].includes(error?.code));
  }

  await assert.rejects(
    () => withTransaction(async () => {
      await query(
        `INSERT INTO dispatch_trucks (
           plate, truck_type, bin_service_enabled, bin_slot_capacity, base_yard_id
         ) VALUES ($1, 'bin', true, 1, $2)`,
        [`${PLATE_PREFIX}-NO-SIZE`, yardId]
      );
    }),
    (error) => ["23514", "55000"].includes(error?.code),
    "A Bin truck without one active supported bin type must fail at commit."
  );

  await assert.rejects(
    () => withTransaction(async () => {
      const inserted = await query(
        `INSERT INTO dispatch_trucks (
           plate, truck_type, bin_service_enabled, bin_slot_capacity, base_yard_id
         ) VALUES ($1, 'flatbed', false, 0, NULL)
         RETURNING id`,
        [`${PLATE_PREFIX}-FLAT-SIZE`]
      );
      await query(
        `INSERT INTO dispatch_truck_bin_types (truck_id, bin_type_id, active)
         VALUES ($1, $2, true)`,
        [inserted.rows[0].id, binTypeId]
      );
    }),
    (error) => ["23514", "55000"].includes(error?.code),
    "A Flatbed truck cannot gain an active supported BIN size."
  );
});

test("P3-F10: Dispatch repository round-trips one explicitly configured Bin truck", async () => {
  const inserted = await insertValidBinTruck("ROUNDTRIP");
  const trucks = await listDispatchTrucks({ activeOnly: false });
  const truck = trucks.find(({ id }) => id === inserted.id);
  assert.deepEqual(truck, {
    id: inserted.id,
    plate: `${PLATE_PREFIX}-ROUNDTRIP`,
    active: true,
    capacityLbs: 52000,
    travelTimePercent: 7.5,
    baseYard: "3445",
    displayOrder: 0,
    truckType: "bin",
    revision: inserted.revision,
    binServiceEnabled: true,
    binSlotCapacity: 2,
    supportedBinTypeCodes: ["14YD"]
  });
});

test("P3-F10: a legacy truck edit omitting every Phase 3 field preserves Bin capabilities", async () => {
  const inserted = await insertValidBinTruck("LEGACY");
  const result = await replaceDispatchFleetSetup({
    drivers: [],
    trucks: [{
      id: inserted.id,
      plate: `${PLATE_PREFIX}-LEGACY`,
      capacityLbs: 54000,
      travelTimePercent: 8,
      baseYard: "3445",
      active: true
    }]
  }, { activeOnly: false, deactivateMissing: false });
  const projected = result.trucks.find(({ id }) => id === inserted.id);
  assert.ok(projected);
  assert.deepEqual({
    capacityLbs: projected.capacityLbs,
    travelTimePercent: projected.travelTimePercent,
    truckType: projected.truckType,
    revision: projected.revision,
    binServiceEnabled: projected.binServiceEnabled,
    binSlotCapacity: projected.binSlotCapacity,
    supportedBinTypeCodes: projected.supportedBinTypeCodes
  }, {
    capacityLbs: 54000,
    travelTimePercent: 8,
    truckType: "bin",
    revision: inserted.revision,
    binServiceEnabled: true,
    binSlotCapacity: 2,
    supportedBinTypeCodes: ["14YD"]
  });

  const stored = await query(
    `SELECT truck_type,
            truck.revision::int AS revision,
            bin_service_enabled,
            bin_slot_capacity,
            base_yard_id::text AS base_yard_id,
            array_agg(type.type_code ORDER BY type.type_code)
              FILTER (WHERE supported.active) AS supported_codes
       FROM dispatch_trucks truck
       LEFT JOIN dispatch_truck_bin_types supported ON supported.truck_id = truck.id
       LEFT JOIN mbt_bin_types type ON type.bin_type_id = supported.bin_type_id
      WHERE truck.id = $1
      GROUP BY truck.id`,
    [inserted.id]
  );
  assert.deepEqual(stored.rows[0], {
    truck_type: "bin",
    revision: inserted.revision,
    bin_service_enabled: true,
    bin_slot_capacity: 2,
    base_yard_id: (await referenceIds()).yard_id,
    supported_codes: ["14YD"]
  });
});

test("P3-F10 hardening: a legacy edit cannot desynchronize a Bin truck's yard code from its relational base yard", async () => {
  const inserted = await insertValidBinTruck("LEGACY-YARD");
  await replaceDispatchFleetSetup({
    drivers: [],
    trucks: [{
      id: inserted.id,
      plate: `${PLATE_PREFIX}-LEGACY-YARD`,
      capacityLbs: 54000,
      travelTimePercent: 8,
      baseYard: "12441",
      active: true
    }]
  }, { activeOnly: false, deactivateMissing: false });

  const stored = await query(
    `SELECT truck.base_yard,
            yard.yard_code AS relational_base_yard
       FROM dispatch_trucks truck
       LEFT JOIN mbt_yards yard ON yard.yard_id = truck.base_yard_id
      WHERE truck.id = $1`,
    [inserted.id]
  );
  assert.deepEqual(stored.rows[0], {
    base_yard: "3445",
    relational_base_yard: "3445"
  });
});
