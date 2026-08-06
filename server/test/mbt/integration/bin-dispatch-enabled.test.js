import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { closeDb, pool, query, withTransaction } from "../../../src/db.js";
import { updateDispatchTruckCapabilities } from "../../../src/mbt/dispatch-truck-capability-repository.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { reserveAsset } from "../../../src/mbt/asset-service.js";
import { createAssetFixture } from "../support/asset-fixtures.js";
import {
  binAssignmentCommand,
  binDispatchPlanDate,
  createBinDispatchFixture,
  durableBinDispatchState,
  enabledBinDispatchBoundary,
  ordinaryDispatchSideEffects
} from "../support/bin-dispatch-fixtures.js";

const binDispatch = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/bin-dispatch-service.js"
).catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
  return {};
}));

/** @param {string} name */
function requiredOperation(name) {
  const operation = binDispatch[name];
  assert.equal(
    typeof operation,
    "function",
    `P3.8 requires the ${name} atomic BIN Dispatch operation.`
  );
  return operation;
}

/** @param {unknown} error @param {string} code */
function isMbtConflict(error, code) {
  return error instanceof MbtError && error.status === 409 && error.code === code;
}

/** @param {Record<string, unknown>} state @param {string} loadId @param {string} visitId */
function visitStops(state, loadId, visitId) {
  const trucks = Array.isArray(state.trucks) ? state.trucks : [];
  const load = trucks
    .flatMap((truck) => Array.isArray(truck.loads) ? truck.loads : [])
    .find((candidate) => candidate.id === loadId);
  return (Array.isArray(load?.stops) ? load.stops : [])
    .filter((stop) => stop?.mbt?.visitId === visitId);
}

/** @param {() => Promise<unknown>} operation */
async function withMasterDataEnabled(operation) {
  const environmentBefore = {
    enabled: config.mbt.enabled,
    masterDataEnabled: config.mbtPhase3.masterDataEnabled
  };
  const flags = await query(
    `SELECT flag_key, enabled, revision, updated_by, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = ANY($1::text[])
      ORDER BY flag_key`,
    [["mbt_enabled", "mbt_master_data"]]
  );
  assert.equal(flags.rowCount, 2);
  try {
    config.mbt.enabled = true;
    config.mbtPhase3.masterDataEnabled = true;
    await query(
      `UPDATE mbt_feature_flags
          SET enabled = true, updated_by = 'p3-bin-dispatch-test', updated_at = now()
        WHERE flag_key = ANY($1::text[])`,
      [["mbt_enabled", "mbt_master_data"]]
    );
    return await operation();
  } finally {
    config.mbt.enabled = environmentBefore.enabled;
    config.mbtPhase3.masterDataEnabled = environmentBefore.masterDataEnabled;
    for (const flag of flags.rows) {
      await query(
        `UPDATE mbt_feature_flags
            SET enabled = $2, revision = $3, updated_by = $4, updated_at = $5
          WHERE flag_key = $1`,
        [flag.flag_key, flag.enabled, flag.revision, flag.updated_by, flag.updated_at]
      );
    }
  }
}

/** @param {string} label @param {boolean} reserve */
async function createCapabilityProtectionFixture(label, reserve) {
  const client = await pool.connect();
  let fixture;
  try {
    fixture = await createAssetFixture(client, { assetCount: 1, visitCount: 1 });
  } finally {
    client.release();
  }
  const dateOffset = Number.parseInt(
    crypto.randomUUID().replaceAll("-", "").slice(0, 6),
    16
  ) % 5_000;
  const planDate = new Date(
    Date.UTC(2090, 0, 1) + dateOffset * 86_400_000
  ).toISOString().slice(0, 10);
  await withTransaction(async () => {
    await query(
      `UPDATE dispatch_trucks
          SET truck_type = 'bin', bin_service_enabled = true,
              bin_slot_capacity = 1, base_yard = $2, base_yard_id = $3
        WHERE id = $1`,
      [fixture.truckId, fixture.yardCode, fixture.yardId]
    );
    await query(
      `INSERT INTO dispatch_truck_bin_types (truck_id, bin_type_id, active, created_by)
       VALUES ($1, '00000000-0000-4000-8000-000000000020', true, 'p3-bin-dispatch-test')`,
      [fixture.truckId]
    );
  });
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note, revision)
     VALUES ($1::date, 'draft', $2, 1)
     RETURNING id::text`,
    [planDate, `P3.8 truck capability protection ${label}`]
  );
  const loadId = `P3-CAP-${fixture.fixtureId}`;
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, '[]'::jsonb, $2::jsonb, $3::jsonb)`,
    [
      plan.rows[0].id,
      JSON.stringify([{
        id: fixture.truckId,
        truckType: "bin",
        binSlotCapacity: 1,
        supportedBinTypeCodes: ["20YD"],
        loads: [{
          id: loadId,
          stops: [{
            id: `P3-CAP-STOP-${fixture.fixtureId}`,
            type: "drop",
            mbt: {
              visitId: fixture.visitIds[0],
              stopGroupId: fixture.visitIds[0],
              mandatory: true,
              assetId: fixture.assets[0].assetId,
              binTypeCode: "20YD"
            }
          }]
        }]
      }]),
      JSON.stringify({ dispatchPlanFormat: { version: 2, source: "p3-bin-dispatch-test" } })
    ]
  );
  if (reserve) {
    await reserveAsset(pool, {
      assetId: fixture.assets[0].assetId,
      contractId: fixture.contractId,
      visitId: fixture.visitIds[0],
      reservationSlot: "outgoing",
      reservedFrom: `${planDate}T08:00:00.000Z`,
      reservedUntil: `${planDate}T12:00:00.000Z`,
      reservedBy: "p3-bin-dispatch-test",
      source: "dispatch",
      actorType: "operator",
      actorId: "p3-bin-dispatch-test",
      occurredAt: `${planDate}T07:45:00.000Z`
    });
  }
  const truck = await query(
    `SELECT revision::int, truck_type, bin_service_enabled, bin_slot_capacity
       FROM dispatch_trucks WHERE id = $1`,
    [fixture.truckId]
  );
  return {
    ...fixture,
    planId: String(plan.rows[0].id),
    planDate,
    truckRevision: truck.rows[0].revision
  };
}

/** @param {Awaited<ReturnType<typeof createCapabilityProtectionFixture>>} fixture @param {string} label */
function capabilityChangeCommand(fixture, label) {
  return {
    actor: { operatorId: `p3-capability-${fixture.fixtureId}`, roles: ["admin", "dispatcher"] },
    truckId: fixture.truckId,
    expectedRevision: fixture.truckRevision,
    capability: {
      truckType: "flatbed",
      capacityLbs: 48_000,
      travelTimePercent: 0,
      baseYard: fixture.yardCode,
      binSlotCapacity: 0,
      supportedBinTypeCodes: []
    },
    reason: `P3.8 protected capability change ${label}`,
    idempotencyKey: `p3-capability-${fixture.fixtureId}-${label}`,
    correlationId: `p3-capability-corr-${fixture.fixtureId}-${label}`,
    requestId: `p3-capability-req-${fixture.fixtureId}-${label}`
  };
}

after(async () => {
  await closeDb();
});

test("P3-F16: assignment atomically plans one complete front leg, exact asset, truck, and shared-yard snapshot", async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const fixture = await createBinDispatchFixture({
    label: "atomic-assignment",
    planDate: binDispatchPlanDate(100)
  });
  const ordinaryBefore = await ordinaryDispatchSideEffects();
  const command = binAssignmentCommand(fixture, "atomic-assignment");

  const result = await assignMbtBinFrontLeg(command, {
    capability: enabledBinDispatchBoundary
  });

  assert.equal(result.status, 201);
  assert.equal(result.replayed, false);
  assert.deepEqual({
    schemaVersion: result.body.schemaVersion,
    planId: result.body.planId,
    planDate: result.body.planDate,
    loadId: result.body.loadId,
    visitId: result.body.visitId,
    contractId: result.body.contractId,
    reservationAssetIds: result.body.assetReservations.map(({ assetId }) => assetId),
    stopIds: result.body.stops.map(({ id }) => id)
  }, {
    schemaVersion: "mbt-bin-dispatch-assignment-v1",
    planId: fixture.planId,
    planDate: fixture.planDate,
    loadId: fixture.binLoadIds[0],
    visitId: fixture.frontVisitId,
    contractId: fixture.contractId,
    reservationAssetIds: [fixture.assetId],
    stopIds: fixture.frontStops.map(({ stopId }) => stopId)
  });

  const state = await durableBinDispatchState(fixture);
  assert.deepEqual({
    planStatus: state.plan_status,
    planRevision: state.plan_revision,
    visitStatus: state.visit_status,
    visitRevision: state.visit_revision,
    visitPlanId: state.dispatch_plan_id,
    visitPlanRevision: state.dispatch_plan_revision,
    reservations: state.reservations,
    receipts: state.receipts,
    audits: state.audits
  }, {
    planStatus: "draft",
    planRevision: 2,
    visitStatus: "planned",
    visitRevision: 2,
    visitPlanId: fixture.planId,
    visitPlanRevision: 2,
    reservations: 1,
    receipts: 1,
    audits: 1
  });
  const stops = visitStops(state, fixture.binLoadIds[0], fixture.frontVisitId);
  assert.deepEqual(stops.map((stop) => ({
    id: stop.id,
    sequence: stop.mbt.stopSequence,
    stopGroupId: stop.mbt.stopGroupId,
    immutable: stop.mbt.mandatory,
    truckType: stop.mbt.capabilitySnapshot.truckType,
    binTypeCode: stop.mbt.capabilitySnapshot.binTypeCode,
    yardId: stop.mbt.capabilitySnapshot.baseYardId,
    yardCode: stop.mbt.capabilitySnapshot.baseYardCode
  })), fixture.frontStops.map(({ stopId, sequence }) => ({
    id: stopId,
    sequence,
    stopGroupId: fixture.frontVisitId,
    immutable: true,
    truckType: "bin",
    binTypeCode: fixture.binTypeCode,
    yardId: "00000000-0000-4000-8000-000000012441",
    yardCode: "12441"
  })));
  assert.deepEqual(await ordinaryDispatchSideEffects(), ordinaryBefore);
});

test("P3-F16: exact retry replays one result while changed payload and stale revisions fail closed", async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const fixture = await createBinDispatchFixture({
    label: "assignment-replay",
    planDate: binDispatchPlanDate(110)
  });
  const command = binAssignmentCommand(fixture, "assignment-replay");
  const first = await assignMbtBinFrontLeg(command, {
    capability: enabledBinDispatchBoundary
  });
  const replay = await assignMbtBinFrontLeg(structuredClone(command), {
    capability: enabledBinDispatchBoundary
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);

  await assert.rejects(
    () => assignMbtBinFrontLeg({ ...command, loadId: fixture.binLoadIds[1] }, {
      capability: enabledBinDispatchBoundary
    }),
    (error) => isMbtConflict(error, "MBT_IDEMPOTENCY_PAYLOAD_CONFLICT")
  );
  const stale = binAssignmentCommand(fixture, "assignment-stale", {
    expectedVisitRevision: 99,
    expectedPlanRevision: 99
  });
  await assert.rejects(
    () => assignMbtBinFrontLeg(stale, { capability: enabledBinDispatchBoundary }),
    (error) => isMbtConflict(error, "MBT_BIN_DISPATCH_STALE_REVISION")
  );
  const state = await durableBinDispatchState(fixture);
  assert.equal(state.reservations, 1);
  assert.equal(state.receipts, 1);
  assert.equal(state.audits, 1);
});

test("P3-F16: a Flatbed, unsupported type, wrong asset, or incomplete pilot boundary leaves the leg untouched", async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const fixture = await createBinDispatchFixture({
    label: "capability-rejections",
    planDate: binDispatchPlanDate(120)
  });
  const before = await durableBinDispatchState(fixture);
  const attempts = [
    {
      input: binAssignmentCommand(fixture, "flatbed", { loadId: fixture.flatbedLoadId }),
      code: "MBT_BIN_TRUCK_REQUIRED"
    },
    {
      input: binAssignmentCommand(fixture, "wrong-asset", {
        assetAssignments: [{
          reservationSlot: "outgoing",
          assetId: "00000000-0000-4000-8000-000000000999",
          expectedStateRevision: 1
        }]
      }),
      code: "MBT_BIN_ASSET_MISMATCH"
    }
  ];
  for (const { input, code } of attempts) {
    await assert.rejects(
      () => assignMbtBinFrontLeg(input, { capability: enabledBinDispatchBoundary }),
      (error) => isMbtConflict(error, code)
    );
  }
  for (const capability of [
    { ...enabledBinDispatchBoundary, environmentEnabled: false },
    { ...enabledBinDispatchBoundary, databaseEnabled: false },
    { ...enabledBinDispatchBoundary, pilotAuthorized: false }
  ]) {
    await assert.rejects(
      () => assignMbtBinFrontLeg(
        binAssignmentCommand(fixture, `closed-${Object.values(capability).join("-")}`),
        { capability }
      ),
      (error) => isMbtConflict(error, "MBT_CAPABILITY_DISABLED")
    );
  }
  assert.deepEqual(await durableBinDispatchState(fixture), before);
});

test("P3-F16: failure after reservation rolls back reservation, visit, plan snapshot, receipt, and audit", async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const fixture = await createBinDispatchFixture({
    label: "assignment-rollback",
    planDate: binDispatchPlanDate(130)
  });
  const before = await durableBinDispatchState(fixture);
  const injected = new Error("synthetic failure after reservation");

  await assert.rejects(
    () => assignMbtBinFrontLeg(binAssignmentCommand(fixture, "rollback"), {
      capability: enabledBinDispatchBoundary,
      hooks: {
        afterReservation: () => {
          throw injected;
        }
      }
    }),
    (error) => error === injected
  );
  assert.deepEqual(await durableBinDispatchState(fixture), before);
});

test("P3-F17: moving an unstarted leg transfers the complete stop group and reservation atomically", async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const moveMbtBinFrontLegAssignment = requiredOperation("moveMbtBinFrontLegAssignment");
  const fixture = await createBinDispatchFixture({
    label: "whole-leg-move",
    planDate: binDispatchPlanDate(140)
  });
  const assigned = await assignMbtBinFrontLeg(
    binAssignmentCommand(fixture, "whole-leg-move"),
    { capability: enabledBinDispatchBoundary }
  );
  const moved = await moveMbtBinFrontLegAssignment({
    actor: { operatorId: `p3-bin-dispatcher-${fixture.suffix}`, roles: ["dispatcher"] },
    planId: fixture.planId,
    planDate: fixture.planDate,
    visitId: fixture.frontVisitId,
    fromLoadId: fixture.binLoadIds[0],
    toLoadId: fixture.binLoadIds[1],
    expectedVisitRevision: assigned.body.visitRevision,
    expectedPlanRevision: assigned.body.planRevision,
    reason: "Move the complete unstarted synthetic leg",
    idempotencyKey: `p3-bin-move-${fixture.suffix}`,
    correlationId: `p3-bin-move-corr-${fixture.suffix}`,
    requestId: `p3-bin-move-req-${fixture.suffix}`
  }, { capability: enabledBinDispatchBoundary });

  assert.equal(moved.status, 200);
  assert.equal(moved.body.schemaVersion, "mbt-bin-dispatch-assignment-v1");
  assert.equal(moved.body.loadId, fixture.binLoadIds[1]);
  const state = await durableBinDispatchState(fixture);
  assert.deepEqual(visitStops(state, fixture.binLoadIds[0], fixture.frontVisitId), []);
  assert.deepEqual(
    visitStops(state, fixture.binLoadIds[1], fixture.frontVisitId).map(({ id }) => id),
    fixture.frontStops.map(({ stopId }) => stopId)
  );
  assert.equal(state.reservations, 1);
});

test("P3-F17: a partial-stop move, mandatory-stop deletion, and ordinary generic save cannot split a BIN leg", async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const moveMbtBinFrontLegAssignment = requiredOperation("moveMbtBinFrontLegAssignment");
  const fixture = await createBinDispatchFixture({
    label: "split-rejection",
    planDate: binDispatchPlanDate(150)
  });
  const assigned = await assignMbtBinFrontLeg(
    binAssignmentCommand(fixture, "split-rejection"),
    { capability: enabledBinDispatchBoundary }
  );
  const before = await durableBinDispatchState(fixture);
  for (const overrides of [
    { stopIds: [fixture.frontStops[0].stopId] },
    { stopIds: fixture.frontStops.map(({ stopId }) => stopId).reverse() },
    { toLoadId: fixture.flatbedLoadId }
  ]) {
    await assert.rejects(
      () => moveMbtBinFrontLegAssignment({
        actor: { operatorId: `p3-bin-dispatcher-${fixture.suffix}`, roles: ["dispatcher"] },
        planId: fixture.planId,
        planDate: fixture.planDate,
        visitId: fixture.frontVisitId,
        fromLoadId: fixture.binLoadIds[0],
        toLoadId: fixture.binLoadIds[1],
        expectedVisitRevision: assigned.body.visitRevision,
        expectedPlanRevision: assigned.body.planRevision,
        reason: "Synthetic prohibited split",
        idempotencyKey: `p3-bin-split-${fixture.suffix}-${JSON.stringify(overrides)}`,
        correlationId: `p3-bin-split-corr-${fixture.suffix}`,
        requestId: `p3-bin-split-req-${fixture.suffix}`,
        ...overrides
      }, { capability: enabledBinDispatchBoundary }),
      (error) => error instanceof MbtError
        && error.status === 409
        && ["MBT_BIN_LEG_SPLIT_FORBIDDEN", "MBT_BIN_TRUCK_REQUIRED"].includes(error.code)
    );
  }
  assert.deepEqual(await durableBinDispatchState(fixture), before);
});

test("P3-F16 control: a future BIN plan reference prevents changing its truck to Flatbed", async () => {
  const fixture = await createCapabilityProtectionFixture("future-plan", false);
  const before = await query(
    `SELECT revision::int, truck_type, bin_service_enabled, bin_slot_capacity
       FROM dispatch_trucks WHERE id = $1`,
    [fixture.truckId]
  );
  await assert.rejects(
    () => withMasterDataEnabled(() => updateDispatchTruckCapabilities(
      capabilityChangeCommand(fixture, "future-plan")
    )),
    (error) => isMbtConflict(error, "MBT_TRUCK_CAPABILITY_IN_USE")
  );
  const afterState = await query(
    `SELECT revision::int, truck_type, bin_service_enabled, bin_slot_capacity
       FROM dispatch_trucks WHERE id = $1`,
    [fixture.truckId]
  );
  assert.deepEqual(afterState.rows, before.rows);
});

test("P3-F16 control: an active whole-leg reservation prevents removing its required truck type and BIN-size support", async () => {
  const fixture = await createCapabilityProtectionFixture("active-reservation", true);
  const evidenceBefore = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_bin_asset_reservations
         WHERE visit_id = $1 AND released_at IS NULL) AS reservations,
       (SELECT revision::int FROM dispatch_trucks WHERE id = $2) AS truck_revision,
       (SELECT count(*)::int FROM dispatch_plan_snapshots WHERE plan_id = $3) AS snapshots`,
    [fixture.visitIds[0], fixture.truckId, fixture.planId]
  );
  await assert.rejects(
    () => withMasterDataEnabled(() => updateDispatchTruckCapabilities(
      capabilityChangeCommand(fixture, "active-reservation")
    )),
    (error) => isMbtConflict(error, "MBT_TRUCK_CAPABILITY_IN_USE")
  );
  const evidenceAfter = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_bin_asset_reservations
         WHERE visit_id = $1 AND released_at IS NULL) AS reservations,
       (SELECT revision::int FROM dispatch_trucks WHERE id = $2) AS truck_revision,
       (SELECT count(*)::int FROM dispatch_plan_snapshots WHERE plan_id = $3) AS snapshots`,
    [fixture.visitIds[0], fixture.truckId, fixture.planId]
  );
  assert.deepEqual(evidenceAfter.rows, evidenceBefore.rows);
});
