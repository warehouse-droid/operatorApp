// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";
import { replaceDispatchFleetSetup } from "../../../src/dispatch-setup-repository.js";
import { updateDispatchTruckCapabilities } from "../../../src/mbt/dispatch-truck-capability-repository.js";

const suffix = crypto.randomUUID().replaceAll("-", "");
const actor = Object.freeze({
  operatorId: `p3-truck-branches-${suffix}`,
  roles: Object.freeze(["admin"])
});
const plate = `P3-BR-${suffix.slice(0, 20)}`.toUpperCase();
const originalEnvironment = {
  enabled: config.mbt.enabled,
  masterDataEnabled: config.mbtPhase3.masterDataEnabled
};
let originalFlags = [];
let truckId = "";
let sequence = 0;

function capability(overrides = {}) {
  return {
    truckType: "flatbed",
    capacityLbs: 48000,
    travelTimePercent: 0,
    baseYard: "3445",
    binSlotCapacity: 0,
    supportedBinTypeCodes: [],
    ...overrides
  };
}

function command(overrides = {}) {
  sequence += 1;
  return {
    actor,
    truckId,
    expectedRevision: 1,
    capability: capability(),
    reason: "P3 truck capability branch contract",
    idempotencyKey: `p3-truck-branches-idem-${suffix}-${sequence}`,
    correlationId: `p3-truck-branches-corr-${suffix}-${sequence}`,
    requestId: `p3-truck-branches-req-${suffix}-${sequence}`,
    ...overrides
  };
}

before(async () => {
  originalFlags = (await query(
    `SELECT flag_key, enabled, revision, updated_by, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = ANY($1::text[])
      ORDER BY flag_key`,
    [["mbt_enabled", "mbt_master_data"]]
  )).rows;
  const fleet = await replaceDispatchFleetSetup({
    drivers: [],
    trucks: [{
      plate,
      capacityLbs: 47000,
      travelTimePercent: 3,
      baseYard: "3445",
      active: true
    }]
  }, { activeOnly: false, deactivateMissing: false });
  truckId = String(fleet.trucks.find((truck) => truck.plate === plate)?.id || "");
  assert.match(truckId, /^[1-9]\d*$/u);
});

after(async () => {
  config.mbt.enabled = originalEnvironment.enabled;
  config.mbtPhase3.masterDataEnabled = originalEnvironment.masterDataEnabled;
  for (const flag of originalFlags) {
    await query(
      `UPDATE mbt_feature_flags
          SET enabled = $2, revision = $3, updated_by = $4, updated_at = $5
        WHERE flag_key = $1`,
      [flag.flag_key, flag.enabled, flag.revision, flag.updated_by, flag.updated_at]
    ).catch(() => undefined);
  }
  if (truckId) {
    await query("DELETE FROM dispatch_truck_capability_history WHERE truck_id = $1", [truckId]).catch(() => undefined);
    await query("DELETE FROM dispatch_truck_bin_types WHERE truck_id = $1", [truckId]).catch(() => undefined);
    await query("DELETE FROM dispatch_trucks WHERE id = $1", [truckId]).catch(() => undefined);
  }
  await query("DELETE FROM mbt_command_receipts WHERE actor_operator_id = $1", [actor.operatorId]).catch(() => undefined);
  await query("DELETE FROM mbt_audit_events WHERE actor_operator_id = $1", [actor.operatorId]).catch(() => undefined);
  await closeDb();
});

test("P3-F10 branch contract: every malformed truck capability fails before durable work", async () => {
  const invalidCommands = [
    command({ truckId: null }),
    command({ truckId: "0" }),
    command({ truckId: "1.5" }),
    command({ expectedRevision: undefined }),
    command({ expectedRevision: 0 }),
    command({ expectedRevision: "1" }),
    command({ capability: null }),
    command({ capability: [] }),
    command({ capability: { ...capability(), unsupported: true } }),
    command({ capability: capability({ truckType: "crane" }) }),
    command({ capability: capability({ supportedBinTypeCodes: "14YD" }) }),
    command({ capability: capability({ supportedBinTypeCodes: [null] }) }),
    command({ capability: capability({ capacityLbs: 0 }) }),
    command({ capability: capability({ capacityLbs: Number.POSITIVE_INFINITY }) }),
    command({ capability: capability({ travelTimePercent: -1 }) }),
    command({ capability: capability({ travelTimePercent: "not-a-number" }) }),
    command({ capability: capability({
      truckType: "bin",
      baseYard: "",
      binSlotCapacity: 1,
      supportedBinTypeCodes: ["14YD"]
    }) }),
    command({ capability: capability({
      truckType: "bin",
      baseYard: "3445",
      binSlotCapacity: 0,
      supportedBinTypeCodes: ["14YD"]
    }) }),
    command({ capability: capability({
      truckType: "bin",
      baseYard: "3445",
      binSlotCapacity: 1.5,
      supportedBinTypeCodes: ["14YD"]
    }) }),
    command({ capability: capability({
      truckType: "bin",
      baseYard: "3445",
      binSlotCapacity: 1,
      supportedBinTypeCodes: []
    }) }),
    command({ capability: capability({ supportedBinTypeCodes: ["14YD"] }) }),
    command({ reason: "  " })
  ];
  const evidenceBefore = await query(
    `SELECT
       (SELECT revision::int FROM dispatch_trucks WHERE id = $1) AS revision,
       (SELECT count(*)::int FROM dispatch_truck_capability_history WHERE truck_id = $1) AS history,
       (SELECT count(*)::int FROM mbt_command_receipts WHERE actor_operator_id = $2) AS receipts`,
    [truckId, actor.operatorId]
  );
  for (const invalid of invalidCommands) {
    await assert.rejects(
      updateDispatchTruckCapabilities(invalid),
      (error) => error?.status === 400
        && ["DISPATCH_TRUCK_CAPABILITY_INVALID", "DISPATCH_TRUCK_REVISION_REQUIRED"].includes(error.code)
    );
  }
  const evidenceAfter = await query(
    `SELECT
       (SELECT revision::int FROM dispatch_trucks WHERE id = $1) AS revision,
       (SELECT count(*)::int FROM dispatch_truck_capability_history WHERE truck_id = $1) AS history,
       (SELECT count(*)::int FROM mbt_command_receipts WHERE actor_operator_id = $2) AS receipts`,
    [truckId, actor.operatorId]
  );
  assert.deepEqual(evidenceAfter.rows, evidenceBefore.rows);
});

test("P3-F10 branch contract: environment, database, and pilot gates fail independently", async () => {
  config.mbt.enabled = false;
  config.mbtPhase3.masterDataEnabled = true;
  await assert.rejects(
    updateDispatchTruckCapabilities(command()),
    (error) => error?.code === "MBT_CAPABILITY_DISABLED"
      && error?.details?.reason === "environment_root_disabled"
  );

  config.mbt.enabled = true;
  await query(
    `UPDATE mbt_feature_flags SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], actor.operatorId]
  );
  await assert.rejects(
    updateDispatchTruckCapabilities(command({ actor: { operatorId: actor.operatorId, roles: ["sales"] } })),
    (error) => error?.code === "MBT_CAPABILITY_DISABLED"
      && error?.details?.reason === "pilot_scope_denied"
  );

  await query(
    "UPDATE mbt_feature_flags SET enabled = false WHERE flag_key = 'mbt_master_data'"
  );
  await assert.rejects(
    updateDispatchTruckCapabilities(command()),
    (error) => error?.code === "MBT_CAPABILITY_DISABLED"
      && error?.details?.reason === "database_capability_disabled"
  );
});

test("P3-F10 branch contract: flatbed, BIN, unavailable reference, and safe removal paths remain exact", async () => {
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  await query(
    `UPDATE mbt_feature_flags SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], actor.operatorId]
  );

  await assert.rejects(
    updateDispatchTruckCapabilities(command({ truckId: "9223372036854775807" })),
    (error) => error?.code === "DISPATCH_TRUCK_NOT_FOUND"
  );

  const flatbed = await updateDispatchTruckCapabilities(command());
  assert.equal(flatbed.body.truck.truckType, "flatbed");
  assert.equal(flatbed.body.truck.binServiceEnabled, false);
  assert.equal(flatbed.body.truck.binSlotCapacity, 0);
  assert.deepEqual(flatbed.body.truck.supportedBinTypeCodes, []);

  const binCapability = capability({
    truckType: "bin",
    capacityLbs: 52000,
    travelTimePercent: 7,
    binSlotCapacity: 2,
    supportedBinTypeCodes: ["20yd", "14YD", "14yd"]
  });
  const bin = await updateDispatchTruckCapabilities(command({
    expectedRevision: flatbed.body.truck.revision,
    capability: binCapability
  }));
  assert.equal(bin.body.truck.truckType, "bin");
  assert.equal(bin.body.truck.binServiceEnabled, true);
  assert.deepEqual(bin.body.truck.supportedBinTypeCodes, ["14YD", "20YD"]);

  const retained = await updateDispatchTruckCapabilities(command({
    expectedRevision: bin.body.truck.revision,
    capability: { ...binCapability, capacityLbs: 52500 }
  }));
  assert.equal(retained.body.truck.revision, bin.body.truck.revision + 1);

  await assert.rejects(
    updateDispatchTruckCapabilities(command({
      expectedRevision: retained.body.truck.revision,
      capability: { ...binCapability, baseYard: "UNKNOWN" }
    })),
    (error) => error?.code === "DISPATCH_TRUCK_CAPABILITY_INVALID"
      && /base yard is unavailable/u.test(error.message)
  );
  await assert.rejects(
    updateDispatchTruckCapabilities(command({
      expectedRevision: retained.body.truck.revision,
      capability: { ...binCapability, supportedBinTypeCodes: ["99YD"] }
    })),
    (error) => error?.code === "DISPATCH_TRUCK_CAPABILITY_INVALID"
      && /BIN size is unavailable/u.test(error.message)
  );

  const returnedFlatbed = await updateDispatchTruckCapabilities(command({
    expectedRevision: retained.body.truck.revision,
    capability: capability({ capacityLbs: 50000, travelTimePercent: 4 })
  }));
  assert.equal(returnedFlatbed.body.truck.truckType, "flatbed");
  assert.equal(returnedFlatbed.body.truck.revision, retained.body.truck.revision + 1);
  assert.deepEqual(returnedFlatbed.body.truck.supportedBinTypeCodes, []);
});
