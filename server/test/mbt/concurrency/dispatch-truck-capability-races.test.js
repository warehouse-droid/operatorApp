// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import * as dispatchSetupRepository from "../../../src/dispatch-setup-repository.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const PLATE = `P3-RACE-${RUN_ID.slice(0, 18).toUpperCase()}`;
const ACTOR = Object.freeze({
  operatorId: `p3-truck-race-${RUN_ID}`,
  roles: Object.freeze(["admin", "dispatcher"])
});
const RACE_REPETITIONS = 25;
let truckId = "";
let commandSequence = 0;
/** @type {Array<{flag_key: string, enabled: boolean, revision: string, updated_by: string | null, updated_at: Date}>} */
let originalFlags = [];
const originalEnvironment = Object.freeze({
  enabled: config.mbt.enabled,
  masterDataEnabled: config.mbtPhase3.masterDataEnabled
});

after(async () => {
  if (truckId) {
    await withTransaction(async () => {
      await query("DELETE FROM dispatch_truck_bin_types WHERE truck_id = $1", [truckId]);
      await query("DELETE FROM dispatch_trucks WHERE id = $1", [truckId]);
    }).catch(() => undefined);
  }
  if (originalFlags.length) {
    for (const flag of originalFlags) {
      await query(
        `UPDATE mbt_feature_flags
            SET enabled = $2,
                revision = $3,
                updated_by = $4,
                updated_at = $5
          WHERE flag_key = $1`,
        [flag.flag_key, flag.enabled, flag.revision, flag.updated_by, flag.updated_at]
      ).catch(() => undefined);
    }
  }
  config.mbt.enabled = originalEnvironment.enabled;
  config.mbtPhase3.masterDataEnabled = originalEnvironment.masterDataEnabled;
  await closeDb();
});

async function enableMasterDataForThisIsolatedTest() {
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
        SET enabled = true,
            updated_by = $2,
            updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
  );
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
}

async function seedTruck() {
  const references = await query(
    `SELECT
       (SELECT yard_id::text FROM mbt_yards WHERE yard_code = '3445') AS yard_id,
       (SELECT bin_type_id::text FROM mbt_bin_types WHERE type_code = '14YD') AS bin_type_id`
  );
  assert.match(String(references.rows[0]?.yard_id || ""), /^[0-9a-f-]{36}$/i);
  return withTransaction(async () => {
    const inserted = await query(
      `INSERT INTO dispatch_trucks (
         plate, capacity_lbs, travel_time_percent, base_yard, active,
         truck_type, bin_service_enabled, bin_slot_capacity, base_yard_id
       ) VALUES ($1, 52000, 5, '3445', true, 'bin', true, 1, $2)
       RETURNING id::text AS id, revision::int AS revision`,
      [PLATE, references.rows[0].yard_id]
    );
    truckId = inserted.rows[0].id;
    await query(
      `INSERT INTO dispatch_truck_bin_types (truck_id, bin_type_id, active, created_by)
       VALUES ($1, $2, true, $3)`,
      [truckId, references.rows[0].bin_type_id, ACTOR.operatorId]
    );
    return inserted.rows[0];
  });
}

function command(expectedRevision, iteration, side) {
  commandSequence += 1;
  const identity = `${RUN_ID}-${commandSequence}`;
  const right = side === "right";
  return {
    actor: ACTOR,
    truckId,
    expectedRevision,
    capability: {
      truckType: "bin",
      capacityLbs: 52000 + iteration + (right ? 1 : 0),
      travelTimePercent: right ? 8 : 7,
      baseYard: "3445",
      binSlotCapacity: right ? 2 : 1,
      supportedBinTypeCodes: right ? ["14YD", "20YD"] : ["14YD"]
    },
    reason: `P3 truck capability race ${iteration} ${side}`,
    idempotencyKey: `p3-truck-race-idem-${identity}`,
    correlationId: `p3-truck-race-corr-${identity}`,
    requestId: `p3-truck-race-req-${identity}`
  };
}

test("P3-F10: 25 two-client capability races produce one revision winner and one stale loser", {
  timeout: 120_000
}, async () => {
  assert.equal(
    typeof dispatchSetupRepository.updateDispatchTruckCapabilities,
    "function",
    "Dispatch needs one optimistic command for type, yard, slots, weight/travel, and supported sizes."
  );
  await enableMasterDataForThisIsolatedTest();
  const seeded = await seedTruck();
  let expectedRevision = seeded.revision;
  const evidenceBefore = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1
           AND action = 'dispatch.truck.capabilities.updated') AS audits,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1
           AND command_name = 'dispatch.truck.capabilities.update') AS receipts`,
    [ACTOR.operatorId]
  );

  for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
    const outcomes = await Promise.allSettled([
      dispatchSetupRepository.updateDispatchTruckCapabilities(command(expectedRevision, iteration, "left")),
      dispatchSetupRepository.updateDispatchTruckCapabilities(command(expectedRevision, iteration, "right"))
    ]);
    const winners = outcomes.filter(({ status }) => status === "fulfilled");
    const losers = outcomes.filter(({ status }) => status === "rejected");
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(losers.length, 1, JSON.stringify(outcomes));
    assert.equal(losers[0].reason?.status, 409);
    assert.equal(losers[0].reason?.code, "DISPATCH_TRUCK_STALE_REVISION");

    const winner = winners[0].value;
    assert.equal(winner.replayed, false);
    assert.equal(winner.body.truck.revision, expectedRevision + 1);
    assert.equal(winner.body.truck.truckType, "bin");
    assert.equal(winner.body.truck.binServiceEnabled, true);
    assert.ok(winner.body.truck.binSlotCapacity >= 1);
    assert.ok(winner.body.truck.supportedBinTypeCodes.length >= 1);
    expectedRevision = winner.body.truck.revision;

    const stored = await query(
      `SELECT truck.revision::int AS revision,
              truck.truck_type,
              truck.bin_service_enabled,
              truck.bin_slot_capacity,
              array_agg(type.type_code ORDER BY type.type_code)
                FILTER (WHERE supported.active) AS supported_codes
         FROM dispatch_trucks truck
         LEFT JOIN dispatch_truck_bin_types supported ON supported.truck_id = truck.id
         LEFT JOIN mbt_bin_types type ON type.bin_type_id = supported.bin_type_id
        WHERE truck.id = $1
        GROUP BY truck.id`,
      [truckId]
    );
    assert.equal(stored.rows[0].revision, expectedRevision);
    assert.equal(stored.rows[0].truck_type, "bin");
    assert.equal(stored.rows[0].bin_service_enabled, true);
    assert.ok(stored.rows[0].bin_slot_capacity >= 1);
    assert.ok(stored.rows[0].supported_codes.length >= 1);
  }

  const evidenceAfter = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1
           AND action = 'dispatch.truck.capabilities.updated') AS audits,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1
           AND command_name = 'dispatch.truck.capabilities.update') AS receipts`,
    [ACTOR.operatorId]
  );
  assert.deepEqual(evidenceAfter.rows[0], {
    audits: evidenceBefore.rows[0].audits + RACE_REPETITIONS,
    receipts: evidenceBefore.rows[0].receipts + RACE_REPETITIONS
  });
});
