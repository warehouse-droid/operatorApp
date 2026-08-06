// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  advanceMbtBinContractLeg,
  assignMbtBinFrontLeg,
  getMbtBinContractTimeline,
  listMbtBinFrontLegs,
  moveMbtBinFrontLegAssignment,
  recoverMbtBinFrontLegAssignment
} from "../../../src/mbt/bin-dispatch-service.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  BIN_DISPATCH_YARD_ID,
  binAssignmentCommand,
  binDispatchPlanDate,
  createBinDispatchFixture,
  durableBinDispatchState,
  enabledBinDispatchBoundary
} from "../support/bin-dispatch-fixtures.js";

const DISPATCHER = Object.freeze({ operatorId: "p3-bin-hardening", roles: ["dispatcher"] });

after(async () => {
  await closeDb();
});

/** @param {unknown} error @param {string} code @param {number} [status] */
function hasCode(error, code, status = 409) {
  return error instanceof MbtError && error.status === status && error.code === code;
}

/** @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture @param {string} label */
function transferCommand(fixture, label) {
  return {
    actor: DISPATCHER,
    planId: fixture.planId,
    planDate: fixture.planDate,
    visitId: fixture.frontVisitId,
    fromLoadId: fixture.binLoadIds[0],
    toLoadId: fixture.binLoadIds[1],
    expectedVisitRevision: 2,
    expectedPlanRevision: 2,
    reason: `P3.8 hardening transfer ${label}`,
    idempotencyKey: `p38-hardening-transfer-${fixture.suffix}-${label}`,
    correlationId: `p38-hardening-transfer-corr-${fixture.suffix}-${label}`,
    requestId: `p38-hardening-transfer-req-${fixture.suffix}-${label}`
  };
}

test("P3-F15/F16 hardening: malformed identity, authorization, revision, and empty timeline inputs fail closed", async () => {
  await assert.rejects(
    () => listMbtBinFrontLegs({}, { capability: enabledBinDispatchBoundary }),
    (error) => hasCode(error, "MBT_BIN_DISPATCH_INPUT_INVALID", 400)
  );
  await assert.rejects(
    () => listMbtBinFrontLegs({ planDate: "03/08/2037" }, { capability: enabledBinDispatchBoundary }),
    (error) => hasCode(error, "MBT_BIN_DISPATCH_INPUT_INVALID", 400)
  );
  await assert.rejects(
    () => listMbtBinFrontLegs({ planDate: "2037-08-03" }, { capability: null }),
    (error) => hasCode(error, "MBT_CAPABILITY_DISABLED")
  );
  await assert.rejects(
    () => getMbtBinContractTimeline({ contractId: crypto.randomUUID() }, {
      capability: enabledBinDispatchBoundary
    }),
    (error) => hasCode(error, "MBT_BIN_CONTRACT_NOT_FOUND", 404)
  );
  await assert.rejects(
    () => assignMbtBinFrontLeg({ actor: { operatorId: "viewer", roles: ["viewer"] } }, {
      capability: enabledBinDispatchBoundary
    }),
    (error) => hasCode(error, "MBT_FORBIDDEN", 403)
  );
  await assert.rejects(
    () => assignMbtBinFrontLeg({
      actor: DISPATCHER,
      planId: "1",
      planDate: "2037-08-03",
      loadId: "load",
      visitId: crypto.randomUUID(),
      expectedVisitRevision: 0,
      expectedPlanRevision: 1,
      assetAssignments: [],
      reason: "Invalid revision must stop before persistence"
    }, { capability: enabledBinDispatchBoundary }),
    (error) => hasCode(error, "MBT_BIN_DISPATCH_INPUT_INVALID", 400)
  );
  await assert.rejects(
    () => assignMbtBinFrontLeg({}, { capability: enabledBinDispatchBoundary }),
    (error) => hasCode(error, "MBT_BIN_DISPATCH_INPUT_INVALID", 400)
  );
  await assert.rejects(
    () => assignMbtBinFrontLeg({ actor: { operatorId: "viewer", roles: "dispatcher" } }, {
      capability: enabledBinDispatchBoundary
    }),
    (error) => hasCode(error, "MBT_FORBIDDEN", 403)
  );
  await assert.rejects(
    () => assignMbtBinFrontLeg({ actor: { operatorId: "admin", roles: ["admin"] } }, {
      capability: enabledBinDispatchBoundary
    }),
    (error) => hasCode(error, "MBT_BIN_DISPATCH_INPUT_INVALID", 400)
  );
  const invalidBase = {
    actor: DISPATCHER,
    planId: "1",
    planDate: "2037-08-03",
    loadId: "load",
    visitId: crypto.randomUUID(),
    expectedPlanRevision: 1,
    assetAssignments: []
  };
  await assert.rejects(
    () => assignMbtBinFrontLeg({
      ...invalidBase,
      expectedVisitRevision: "1",
      reason: "Reject a string revision"
    }, { capability: enabledBinDispatchBoundary }),
    (error) => hasCode(error, "MBT_BIN_DISPATCH_INPUT_INVALID", 400)
  );
  await assert.rejects(
    () => assignMbtBinFrontLeg({
      ...invalidBase,
      expectedVisitRevision: 1
    }, { capability: enabledBinDispatchBoundary }),
    (error) => hasCode(error, "MBT_AUDIT_REASON_REQUIRED", 400)
  );
  const capped = await listMbtBinFrontLegs({ planDate: "2037-08-03", limit: 5_000 }, {
    capability: enabledBinDispatchBoundary
  });
  assert.deepEqual(capped.items, []);
});

test("P3-F15 hardening: a fully terminal contract remains a completed, locked timeline", async () => {
  const fixture = await createBinDispatchFixture({
    label: "completed-timeline",
    planDate: binDispatchPlanDate(20_409)
  });
  await query(
    `UPDATE mbt_service_visits
        SET status = 'completed',
            actual_started_at = scheduled_start_at,
            actual_completed_at = scheduled_end_at,
            updated_at = now()
      WHERE contract_id = $1`,
    [fixture.contractId]
  );
  const timeline = await getMbtBinContractTimeline({ contractId: fixture.contractId }, {
    capability: enabledBinDispatchBoundary
  });
  assert.deepEqual(
    timeline.items.map(({ relation, locked }) => ({ relation, locked })),
    [
      { relation: "completed", locked: true },
      { relation: "completed", locked: true }
    ]
  );
});

test("P3-F15 hardening: a leg with neither exact nor eligible asset evidence cannot produce a draggable card", async () => {
  const fixture = await createBinDispatchFixture({
    label: "projection-incomplete",
    planDate: binDispatchPlanDate(20_400)
  });
  await query(
    `UPDATE mbt_service_visits
        SET expected_asset_id = NULL, outgoing_asset_id = NULL, updated_at = now()
      WHERE service_visit_id = $1`,
    [fixture.frontVisitId]
  );
  await query(
    `UPDATE mbt_bin_assets
        SET under_maintenance = true, updated_at = now()
      WHERE bin_type_id = $1`,
    [fixture.binTypeId]
  );
  await assert.rejects(
    () => listMbtBinFrontLegs({ planDate: fixture.planDate }, {
      capability: enabledBinDispatchBoundary
    }),
    (error) => hasCode(error, "MBT_BIN_FRONT_LEG_INCOMPLETE")
  );
});

test("P3-F15 hardening: valid sparse snapshots use safe customer, address, yard, and outgoing-asset fallbacks", async () => {
  const fixture = await createBinDispatchFixture({
    label: "projection-fallbacks",
    planDate: binDispatchPlanDate(20_405)
  });
  const stored = await query(
    "SELECT service_snapshot FROM mbt_service_visits WHERE service_visit_id = $1",
    [fixture.frontVisitId]
  );
  const serviceSnapshot = structuredClone(stored.rows[0].service_snapshot);
  for (const stop of serviceSnapshot.mandatoryStops) {
    delete stop.yardId;
    delete stop.yardCode;
  }
  await query(
    `UPDATE mbt_service_visits
        SET expected_asset_id = NULL,
            outgoing_asset_id = $2,
            customer_snapshot = $3::jsonb,
            site_snapshot = '{}'::jsonb,
            service_snapshot = $4::jsonb,
            updated_at = now()
      WHERE service_visit_id = $1`,
    [
      fixture.frontVisitId,
      fixture.assetId,
      JSON.stringify({ companyName: "Sparse BIN customer" }),
      JSON.stringify(serviceSnapshot)
    ]
  );
  const feed = await listMbtBinFrontLegs({ planDate: fixture.planDate }, {
    capability: enabledBinDispatchBoundary
  });
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].customer, "Sparse BIN customer");
  assert.equal(feed.items[0].address, "Service site");
  assert.deepEqual(feed.items[0].mbt.sharedYards, []);
  assert.equal(feed.items[0].mbt.assetRequirements[0].exactAssetId, fixture.assetId);
  const assigned = await assignMbtBinFrontLeg(binAssignmentCommand(fixture, "sparse-assignment"), {
    capability: enabledBinDispatchBoundary
  });
  assert.equal(assigned.body.stops[0].mbt.capabilitySnapshot.baseYardId, "");
  assert.equal(assigned.body.stops[0].mbt.capabilitySnapshot.baseYardCode, "");
});

test("P3-F15 hardening: fallback customer and shared-yard roles remain explicit", async () => {
  const fixture = await createBinDispatchFixture({
    label: "projection-role-fallbacks",
    planDate: binDispatchPlanDate(20_407)
  });
  const stored = await query(
    "SELECT service_snapshot FROM mbt_service_visits WHERE service_visit_id = $1",
    [fixture.frontVisitId]
  );
  const serviceSnapshot = structuredClone(stored.rows[0].service_snapshot);
  serviceSnapshot.mandatoryStops[0].locationRole = "return_yard";
  await query(
    `UPDATE mbt_service_visits
        SET customer_snapshot = '{}'::jsonb,
            service_snapshot = $2::jsonb,
            updated_at = now()
      WHERE service_visit_id = $1`,
    [fixture.frontVisitId, JSON.stringify(serviceSnapshot)]
  );
  const returning = await listMbtBinFrontLegs({ planDate: fixture.planDate }, {
    capability: enabledBinDispatchBoundary
  });
  assert.equal(returning.items[0].customer, "BIN customer");
  assert.equal(returning.items[0].mbt.sharedYards[0].role, "return");
  serviceSnapshot.mandatoryStops[0].locationRole = "warehouse_yard";
  await query(
    "UPDATE mbt_service_visits SET service_snapshot = $2::jsonb WHERE service_visit_id = $1",
    [fixture.frontVisitId, JSON.stringify(serviceSnapshot)]
  );
  const service = await listMbtBinFrontLegs({ planDate: fixture.planDate }, {
    capability: enabledBinDispatchBoundary
  });
  assert.equal(service.items[0].mbt.sharedYards[0].role, "service");
});

test("P3-F16 hardening: missing visit, plan, load, wrong date, and missing exact asset fail before effects", async () => {
  const fixture = await createBinDispatchFixture({
    label: "assignment-boundaries",
    planDate: binDispatchPlanDate(20_410)
  });
  const before = await durableBinDispatchState(fixture);
  const attempts = [
    {
      command: binAssignmentCommand(fixture, "missing-visit", { visitId: crypto.randomUUID() }),
      code: "MBT_BIN_VISIT_NOT_FOUND",
      status: 404
    },
    {
      command: binAssignmentCommand(fixture, "missing-plan", { planId: "999999999" }),
      code: "MBT_BIN_DISPATCH_PLAN_NOT_FOUND",
      status: 404
    },
    {
      command: binAssignmentCommand(fixture, "wrong-date", { planDate: "2099-12-31" }),
      code: "MBT_BIN_DISPATCH_STALE_REVISION",
      status: 409
    },
    {
      command: binAssignmentCommand(fixture, "missing-load", { loadId: "missing-load" }),
      code: "MBT_BIN_DISPATCH_LOAD_NOT_FOUND",
      status: 404
    },
    {
      command: binAssignmentCommand(fixture, "missing-assets", { assetAssignments: [] }),
      code: "MBT_BIN_ASSET_MISMATCH",
      status: 409
    }
  ];
  for (const attempt of attempts) {
    await assert.rejects(
      () => assignMbtBinFrontLeg(attempt.command, { capability: enabledBinDispatchBoundary }),
      (error) => hasCode(error, attempt.code, attempt.status)
    );
  }
  assert.deepEqual(await durableBinDispatchState(fixture), before);
});

test("P3-F16 hardening: a plan-only truck identity cannot bypass the canonical fleet lock", async () => {
  const fixture = await createBinDispatchFixture({
    label: "missing-canonical-truck",
    planDate: binDispatchPlanDate(20_420)
  });
  const snapshot = await query("SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id = $1", [fixture.planId]);
  const trucks = structuredClone(snapshot.rows[0].trucks);
  const missingTruckId = "999999999";
  trucks[0].id = missingTruckId;
  trucks[0].loads[0].truckId = missingTruckId;
  await query(
    "UPDATE dispatch_plan_snapshots SET trucks = $2::jsonb WHERE plan_id = $1",
    [fixture.planId, JSON.stringify(trucks)]
  );
  await assert.rejects(
    () => assignMbtBinFrontLeg(binAssignmentCommand(fixture, "missing-canonical-truck"), {
      capability: enabledBinDispatchBoundary
    }),
    (error) => hasCode(error, "MBT_BIN_TRUCK_REQUIRED")
  );
  assert.equal((await durableBinDispatchState(fixture)).reservations, 0);
});

test("P3-F16 hardening: an unavailable shared yard fails before reservation and is recoverable", async () => {
  const fixture = await createBinDispatchFixture({
    label: "inactive-shared-yard",
    planDate: binDispatchPlanDate(20_430)
  });
  await query("UPDATE mbt_yards SET active = false WHERE yard_id = $1", [BIN_DISPATCH_YARD_ID]);
  try {
    await assert.rejects(
      () => assignMbtBinFrontLeg(binAssignmentCommand(fixture, "inactive-shared-yard"), {
        capability: enabledBinDispatchBoundary
      }),
      (error) => hasCode(error, "MBT_BIN_FRONT_LEG_INCOMPLETE")
    );
  } finally {
    await query("UPDATE mbt_yards SET active = true WHERE yard_id = $1", [BIN_DISPATCH_YARD_ID]);
  }
  assert.equal((await durableBinDispatchState(fixture)).reservations, 0);
});

test("P3-F16 hardening: pre-existing visit identity in a load rolls an otherwise valid reservation back", async () => {
  const fixture = await createBinDispatchFixture({
    label: "duplicate-visit-stop",
    planDate: binDispatchPlanDate(20_440)
  });
  const snapshot = await query("SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id = $1", [fixture.planId]);
  const trucks = structuredClone(snapshot.rows[0].trucks);
  trucks[0].loads[0].stops.push({
    id: `duplicate-${fixture.frontVisitId}`,
    type: "drop",
    mbt: { visitId: fixture.frontVisitId, stopGroupId: fixture.frontVisitId, mandatory: true }
  });
  await query(
    "UPDATE dispatch_plan_snapshots SET trucks = $2::jsonb WHERE plan_id = $1",
    [fixture.planId, JSON.stringify(trucks)]
  );
  await assert.rejects(
    () => assignMbtBinFrontLeg(binAssignmentCommand(fixture, "duplicate-visit-stop"), {
      capability: enabledBinDispatchBoundary
    }),
    (error) => hasCode(error, "MBT_BIN_LEG_ALREADY_ASSIGNED")
  );
  const state = await durableBinDispatchState(fixture);
  assert.equal(state.reservations, 0);
  assert.equal(state.receipts, 0);
  assert.equal(state.audits, 0);
});

test("P3-F16 hardening: load-owned truck identity, truck-owned driver, and action labels have bounded fallbacks", async () => {
  const fixture = await createBinDispatchFixture({
    label: "assignment-fallbacks",
    planDate: binDispatchPlanDate(20_445)
  });
  const visit = await query(
    "SELECT service_snapshot FROM mbt_service_visits WHERE service_visit_id = $1",
    [fixture.frontVisitId]
  );
  const serviceSnapshot = structuredClone(visit.rows[0].service_snapshot);
  serviceSnapshot.mandatoryStops[1].actionCode = "synthetic_missing_action";
  await query(
    `UPDATE mbt_service_visits
        SET expected_asset_id = NULL,
            outgoing_asset_id = $2,
            service_snapshot = $3::jsonb,
            updated_at = now()
      WHERE service_visit_id = $1`,
    [fixture.frontVisitId, fixture.assetId, JSON.stringify(serviceSnapshot)]
  );
  const snapshot = await query("SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id = $1", [fixture.planId]);
  const trucks = structuredClone(snapshot.rows[0].trucks);
  delete trucks[0].id;
  delete trucks[0].loads[0].driverId;
  await query(
    "UPDATE dispatch_plan_snapshots SET trucks = $2::jsonb WHERE plan_id = $1",
    [fixture.planId, JSON.stringify(trucks)]
  );
  await assert.rejects(
    () => assignMbtBinFrontLeg(binAssignmentCommand(fixture, "wrong-reservation-slot", {
      assetAssignments: [{
        reservationSlot: "incoming",
        assetId: fixture.assetId,
        expectedStateRevision: fixture.assetStateRevision
      }]
    }), { capability: enabledBinDispatchBoundary }),
    (error) => hasCode(error, "MBT_BIN_ASSET_MISMATCH")
  );
  const assigned = await assignMbtBinFrontLeg(binAssignmentCommand(fixture, "assignment-fallbacks"), {
    capability: enabledBinDispatchBoundary
  });
  assert.equal(assigned.body.stops[1].displayName, "synthetic missing action");
  const planned = await query(
    `SELECT planned_truck_id::text, planned_driver_id::text
       FROM mbt_service_visits
      WHERE service_visit_id = $1`,
    [fixture.frontVisitId]
  );
  assert.deepEqual(planned.rows[0], {
    planned_truck_id: fixture.binTruckId,
    planned_driver_id: fixture.driverId
  });
});

test("P3-F17 hardening: recovery eligibility, assignment identity, and destination load remain fail closed", async () => {
  const fixture = await createBinDispatchFixture({
    label: "transfer-boundaries",
    planDate: binDispatchPlanDate(20_450)
  });
  await assignMbtBinFrontLeg(binAssignmentCommand(fixture, "transfer-boundaries"), {
    capability: enabledBinDispatchBoundary
  });
  const base = transferCommand(fixture, "base");
  await assert.rejects(
    () => recoverMbtBinFrontLegAssignment({
      ...base,
      idempotencyKey: `${base.idempotencyKey}-recovery`
    }, { capability: enabledBinDispatchBoundary }),
    (error) => hasCode(error, "MBT_BIN_RECOVERY_NOT_REQUIRED")
  );
  await assert.rejects(
    () => moveMbtBinFrontLegAssignment({
      ...base,
      fromLoadId: fixture.binLoadIds[1],
      toLoadId: fixture.binLoadIds[2],
      idempotencyKey: `${base.idempotencyKey}-wrong-source`
    }, { capability: enabledBinDispatchBoundary }),
    (error) => hasCode(error, "MBT_BIN_DISPATCH_STALE_REVISION")
  );
  await assert.rejects(
    () => moveMbtBinFrontLegAssignment({
      ...base,
      toLoadId: "missing-target-load",
      idempotencyKey: `${base.idempotencyKey}-missing-target`
    }, { capability: enabledBinDispatchBoundary }),
    (error) => hasCode(error, "MBT_BIN_DISPATCH_LOAD_NOT_FOUND", 404)
  );
  const state = await durableBinDispatchState(fixture);
  assert.equal(state.plan_revision, 2);
  assert.equal(state.visit_revision, 2);
  assert.equal(state.reservations, 1);
});

test("P3-F17 hardening: stale advancement fails and a refreshed command uses its scheduled-time fallback", async () => {
  const fixture = await createBinDispatchFixture({
    label: "stale-advancement",
    planDate: binDispatchPlanDate(20_460)
  });
  await assignMbtBinFrontLeg(binAssignmentCommand(fixture, "stale-advancement"), {
    capability: enabledBinDispatchBoundary
  });
  await query(
    `UPDATE mbt_service_visits
        SET status = 'completed', revision = revision + 1,
            actual_started_at = $2::timestamptz,
            actual_completed_at = NULL,
            updated_at = now()
      WHERE service_visit_id = $1`,
    [
      fixture.frontVisitId,
      `${fixture.planDate}T12:05:00.000Z`
    ]
  );
  await assert.rejects(
    () => advanceMbtBinContractLeg({
      actor: DISPATCHER,
      contractId: fixture.contractId,
      completedVisitId: fixture.frontVisitId,
      expectedCompletedVisitRevision: 3,
      nextVisitId: fixture.successorVisitId,
      expectedNextVisitRevision: 1,
      planId: fixture.planId,
      expectedPlanRevision: 99,
      reason: "Reject stale P3.8 advancement",
      idempotencyKey: `p38-hardening-advance-${fixture.suffix}`,
      correlationId: `p38-hardening-advance-corr-${fixture.suffix}`,
      requestId: `p38-hardening-advance-req-${fixture.suffix}`
    }, { capability: enabledBinDispatchBoundary }),
    (error) => hasCode(error, "MBT_BIN_LEG_ADVANCEMENT_CONFLICT")
  );
  const visits = await query(
    `SELECT service_visit_id::text, status
       FROM mbt_service_visits
      WHERE contract_id = $1
      ORDER BY visit_number`,
    [fixture.contractId]
  );
  assert.deepEqual(visits.rows, [
    { service_visit_id: fixture.frontVisitId, status: "completed" },
    { service_visit_id: fixture.successorVisitId, status: "tentative" }
  ]);
  assert.equal((await durableBinDispatchState(fixture)).reservations, 1);
  const refreshed = await advanceMbtBinContractLeg({
    actor: DISPATCHER,
    contractId: fixture.contractId,
    completedVisitId: fixture.frontVisitId,
    expectedCompletedVisitRevision: 3,
    nextVisitId: fixture.successorVisitId,
    expectedNextVisitRevision: 1,
    planId: fixture.planId,
    expectedPlanRevision: 2,
    reason: "Advance after refreshing stale P3.8 state",
    idempotencyKey: `p38-hardening-advance-refreshed-${fixture.suffix}`,
    correlationId: `p38-hardening-advance-refreshed-corr-${fixture.suffix}`,
    requestId: `p38-hardening-advance-refreshed-req-${fixture.suffix}`
  }, { capability: enabledBinDispatchBoundary });
  assert.equal(refreshed.body.nextStatus, "ready");
  assert.equal((await durableBinDispatchState(fixture)).reservations, 0);
});
