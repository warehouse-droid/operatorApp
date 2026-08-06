// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, pool, query, withTransaction } from "../../../src/db.js";
import { confirmDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { getDriverDayJobs } from "../../../src/driver-repository.js";
import { recordAssetMovement, releaseAssetReservation } from "../../../src/mbt/asset-service.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  binAssignmentCommand,
  binDispatchPlanDate,
  createBinDispatchFixture,
  enabledBinDispatchBoundary
} from "../support/bin-dispatch-fixtures.js";

const binDispatch = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/bin-dispatch-service.js"
));
const DISPATCHER = Object.freeze({ operatorId: "p311-bin-confirmer", roles: Object.freeze(["dispatcher"]) });

/** @param {string} name */
function requiredOperation(name) {
  const operation = binDispatch[name];
  assert.equal(typeof operation, "function", `P3.11 requires ${name}.`);
  return operation;
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return error instanceof MbtError && error.status === 409 && error.code === code;
}

/** @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture */
async function assignFixture(fixture) {
  const assign = requiredOperation("assignMbtBinFrontLeg");
  await assign(binAssignmentCommand(fixture, "confirmation"), {
    capability: enabledBinDispatchBoundary
  });
  return fixture;
}

/** @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture @param {Record<string, unknown>} [dependencies] */
function confirmFixture(fixture, dependencies = {}) {
  const confirm = requiredOperation("confirmMbtBinDispatchPlan");
  return confirm({
    actor: DISPATCHER,
    planId: fixture.planId,
    note: "Confirm the validated P3.11 BIN plan"
  }, {
    capability: enabledBinDispatchBoundary,
    ...dependencies
  });
}

/** @param {string} planId */
async function confirmationState(planId) {
  const result = await query(
    `SELECT plan.status, plan.revision::int,
            (SELECT count(*)::int FROM dispatch_plan_load_assignments assignment
              WHERE assignment.plan_id = plan.id) AS load_assignments
       FROM dispatch_plans plan
      WHERE plan.id = $1`,
    [planId]
  );
  return result.rows[0];
}

/** @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture @param {string} [reason] */
async function assertConfirmationRejected(fixture, reason = "") {
  const before = await confirmationState(fixture.planId);
  await assert.rejects(
    () => confirmFixture(fixture),
    (error) => hasCode(error, "MBT_BIN_CONFIRMATION_INVALID")
      && (!reason || error.details?.reason === reason)
  );
  assert.deepEqual(await confirmationState(fixture.planId), before);
}

/** @param {string} planId @param {(trucks: Record<string, any>[]) => void} mutate */
async function tamperSnapshot(planId, mutate) {
  const selected = await query("SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id = $1", [planId]);
  const trucks = structuredClone(selected.rows[0].trucks);
  mutate(trucks);
  await query("UPDATE dispatch_plan_snapshots SET trucks = $2::jsonb WHERE plan_id = $1", [planId, JSON.stringify(trucks)]);
}

after(async () => {
  await closeDb();
});

test("P3.11 confirmation: a complete dedicated assignment confirms once and projects only its BIN Driver jobs", async () => {
  const fixture = await assignFixture(await createBinDispatchFixture({
    label: "confirm-complete",
    planDate: binDispatchPlanDate(800)
  }));
  const confirmed = await confirmFixture(fixture);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(Number(confirmed.revision), 3);
  assert.deepEqual(await confirmationState(fixture.planId), {
    status: "confirmed",
    revision: 3,
    load_assignments: 4
  });
  const day = await getDriverDayJobs(fixture.driverLogin, {
    date: fixture.planDate,
    allowBin: true,
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
  assert.deepEqual(day.jobs.filter(({ mbt }) => mbt).map(({ mbt }) => mbt.actionCode), [
    "collect_empty_bin",
    "deliver_bin"
  ]);
  assert.equal(day.jobs.filter(({ loadId }) => loadId === fixture.flatbedLoadId).some(({ mbt }) => mbt), false);
});

test("P3.11 confirmation: direct/default repository confirmation remains fail-closed after a dedicated assignment", async () => {
  const fixture = await assignFixture(await createBinDispatchFixture({
    label: "confirm-default-denied",
    planDate: binDispatchPlanDate(801)
  }));
  const before = await confirmationState(fixture.planId);
  await assert.rejects(
    () => confirmDispatchPlan(fixture.planId, { note: "must remain blocked" }),
    (error) => hasCode(error, "MBT_CAPABILITY_DISABLED")
  );
  assert.deepEqual(await confirmationState(fixture.planId), before);
});

const pilotScopeCases = [
  ["missing", async (fixture) => {
    await query("DELETE FROM mbt_driver_pilot_scope WHERE pilot_scope_id = $1", [fixture.pilotScopeId]);
  }],
  ["wrong truck", async (fixture) => {
    await query(
      "UPDATE mbt_driver_pilot_scope SET truck_id = $2 WHERE pilot_scope_id = $1",
      [fixture.pilotScopeId, fixture.flatbedTruckId]
    );
  }],
  ["expired", async (fixture) => {
    await query(
      `UPDATE mbt_driver_pilot_scope
          SET authorized_at = '2000-01-01T00:00:00.000Z'::timestamptz,
              expires_at = '2000-01-02T00:00:00.000Z'::timestamptz
        WHERE pilot_scope_id = $1`,
      [fixture.pilotScopeId]
    );
  }]
];

for (const [index, [label, mutate]] of pilotScopeCases.entries()) {
  test(`P3.11 confirmation: ${label} exact Driver pilot scope aborts atomically`, async () => {
    const fixture = await assignFixture(await createBinDispatchFixture({
      label: `confirm-pilot-${String(label).replaceAll(" ", "-")}`,
      planDate: binDispatchPlanDate(810 + index)
    }));
    await mutate(fixture);
    await assertConfirmationRejected(fixture, "pilot_scope_mismatch");
  });
}

test("P3.11 confirmation: a visit moved off the locked plan date aborts atomically", async () => {
  const fixture = await assignFixture(await createBinDispatchFixture({
    label: "confirm-date-drift",
    planDate: binDispatchPlanDate(813)
  }));
  await query(
    `UPDATE mbt_service_visits
        SET scheduled_start_at = scheduled_start_at + interval '1 day',
            scheduled_end_at = scheduled_end_at + interval '1 day'
      WHERE service_visit_id = $1`,
    [fixture.frontVisitId]
  );
  await assertConfirmationRejected(fixture, "visit_plan_date_mismatch");
});

test("P3.11 confirmation: a changed predecessor/front-leg relationship aborts atomically", async () => {
  const fixture = await assignFixture(await createBinDispatchFixture({
    label: "confirm-predecessor-drift",
    planDate: binDispatchPlanDate(814)
  }));
  await query(
    "UPDATE mbt_service_visits SET status = 'completed' WHERE service_visit_id = $1",
    [fixture.successorVisitId]
  );
  await query(
    "UPDATE mbt_service_visits SET predecessor_visit_id = $2 WHERE service_visit_id = $1",
    [fixture.frontVisitId, fixture.successorVisitId]
  );
  await assertConfirmationRejected(fixture, "front_leg_mismatch");
});

test("P3.11 confirmation: a changed visit template identity aborts atomically", async () => {
  const planDate = binDispatchPlanDate(815);
  const fixture = await assignFixture(await createBinDispatchFixture({
    label: "confirm-template-drift",
    planDate
  }));
  const other = await createBinDispatchFixture({
    label: "confirm-template-other",
    planDate: binDispatchPlanDate(1815)
  });
  const template = await query(
    "SELECT service_template_version_id::text FROM mbt_service_visits WHERE service_visit_id = $1",
    [other.frontVisitId]
  );
  await query(
    "UPDATE mbt_service_visits SET service_template_version_id = $2 WHERE service_visit_id = $1",
    [fixture.frontVisitId, template.rows[0].service_template_version_id]
  );
  await assertConfirmationRejected(fixture, "visit_template_mismatch");
});

test("P3.11 confirmation: aggregate BIN groups cannot exceed the current truck slot capacity", async () => {
  const planDate = binDispatchPlanDate(816);
  const fixture = await assignFixture(await createBinDispatchFixture({
    label: "confirm-capacity-primary",
    planDate
  }));
  const second = await createBinDispatchFixture({
    label: "confirm-capacity-second",
    planDate: binDispatchPlanDate(1816)
  });
  await query(
    `UPDATE mbt_service_visits
        SET scheduled_start_at = $2::date + time '12:00',
            scheduled_end_at = $2::date + time '16:00'
      WHERE service_visit_id = $1`,
    [second.frontVisitId, planDate]
  );
  await query(
    `UPDATE mbt_driver_pilot_scope
        SET plan_date = $2::date, driver_login = $3, truck_id = $4
      WHERE pilot_scope_id = $1`,
    [second.pilotScopeId, planDate, fixture.driverLogin, fixture.binTruckId]
  );
  const assign = requiredOperation("assignMbtBinFrontLeg");
  await assign(binAssignmentCommand(second, "capacity-second", {
    planId: fixture.planId,
    planDate,
    loadId: fixture.binLoadIds[1],
    expectedPlanRevision: 2
  }), { capability: enabledBinDispatchBoundary });
  await assertConfirmationRejected(fixture, "truck_capacity_mismatch");
});

test("P3.11 confirmation: a stale moved asset state aborts atomically", async () => {
  const fixture = await assignFixture(await createBinDispatchFixture({
    label: "confirm-stale-asset",
    planDate: binDispatchPlanDate(817)
  }));
  await recordAssetMovement(pool, {
    assetId: fixture.assetId,
    movementType: "synthetic_unexpected_load",
    afterStatus: "on_truck",
    afterLocation: {
      kind: "truck",
      reference: fixture.binTruckId,
      truckId: fixture.binTruckId
    },
    contractId: fixture.contractId,
    visitId: fixture.frontVisitId,
    truckId: fixture.binTruckId,
    source: "p311-confirm-test",
    actorType: "operator",
    actorId: DISPATCHER.operatorId,
    occurredAt: `${fixture.planDate}T13:00:00.000Z`
  });
  await assertConfirmationRejected(fixture, "asset_state_mismatch");
});

test("P3.11 confirmation: rejected current dump-site material acceptance aborts atomically", async () => {
  const fixture = await createBinDispatchFixture({
    label: "confirm-dump-material",
    planDate: binDispatchPlanDate(818)
  });
  const dumpSiteId = crypto.randomUUID();
  const materialId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_materials (material_id, material_code, display_name, created_by)
     VALUES ($1, $2, 'Synthetic confirmation material', $3)`,
    [materialId, `P311-MAT-${fixture.suffix.slice(0, 12)}`, DISPATCHER.operatorId]
  );
  await query(
    `INSERT INTO mbt_dump_sites (dump_site_id, dump_site_code, display_name, created_by)
     VALUES ($1, $2, 'Synthetic confirmation dump', $3)`,
    [dumpSiteId, `P311-DUMP-${fixture.suffix.slice(0, 12)}`, DISPATCHER.operatorId]
  );
  await query(
    `INSERT INTO mbt_dump_site_materials (
       dump_site_material_id, dump_site_id, material_id, accepted, active, created_by
     ) VALUES ($1, $2, $3, true, true, $4)`,
    [crypto.randomUUID(), dumpSiteId, materialId, DISPATCHER.operatorId]
  );
  await query(
    `UPDATE mbt_service_visits SET dump_site_id = $2, material_id = $3
      WHERE service_visit_id = $1`,
    [fixture.frontVisitId, dumpSiteId, materialId]
  );
  await assignFixture(fixture);
  await query(
    `UPDATE mbt_dump_site_materials SET accepted = false
      WHERE dump_site_id = $1 AND material_id = $2`,
    [dumpSiteId, materialId]
  );
  await assertConfirmationRejected(fixture, "dump_material_mismatch");
});

const tamperCases = [
  ["missing mandatory stop", (trucks) => {
    trucks[0].loads[0].stops.pop();
  }],
  ["split mandatory group", (trucks) => {
    trucks[0].loads[1].stops.push(trucks[0].loads[0].stops.pop());
  }],
  ["extra mandatory stop", (trucks) => {
    trucks[0].loads[0].stops.push({
      ...structuredClone(trucks[0].loads[0].stops[0]),
      id: `${trucks[0].loads[0].stops[0].id}-EXTRA`
    });
  }],
  ["tampered action", (trucks) => {
    trucks[0].loads[0].stops[0].actionCode = "return_bin";
  }]
];

for (const [index, [label, mutate]] of tamperCases.entries()) {
  test(`P3.11 confirmation: ${label} aborts without a status transition`, async () => {
    const fixture = await assignFixture(await createBinDispatchFixture({
      label: `confirm-${String(label).replaceAll(" ", "-")}`,
      planDate: binDispatchPlanDate(802 + index)
    }));
    await tamperSnapshot(fixture.planId, mutate);
    const before = await confirmationState(fixture.planId);
    await assert.rejects(
      () => confirmFixture(fixture),
      (error) => hasCode(error, "MBT_BIN_CONFIRMATION_INVALID")
    );
    assert.deepEqual(await confirmationState(fixture.planId), before);
  });
}

test("P3.11 confirmation: a released required reservation aborts atomically", async () => {
  const fixture = await assignFixture(await createBinDispatchFixture({
    label: "confirm-released-reservation",
    planDate: binDispatchPlanDate(806)
  }));
  const reservation = await query(
    "SELECT reservation_id::text, reserved_at FROM mbt_bin_asset_reservations WHERE visit_id = $1 AND released_at IS NULL",
    [fixture.frontVisitId]
  );
  const releasedAt = new Date(new Date(reservation.rows[0].reserved_at).getTime() + 1_000);
  await releaseAssetReservation(pool, {
    reservationId: String(reservation.rows[0].reservation_id),
    releasedBy: DISPATCHER.operatorId,
    releaseReason: "P3.11 synthetic pre-confirm release",
    source: "p311-confirm-test",
    actorType: "operator",
    actorId: DISPATCHER.operatorId,
    occurredAt: releasedAt
  });
  const before = await confirmationState(fixture.planId);
  await assert.rejects(
    () => confirmFixture(fixture),
    (error) => hasCode(error, "MBT_BIN_CONFIRMATION_INVALID")
  );
  assert.deepEqual(await confirmationState(fixture.planId), before);
});

test("P3.11 confirmation: a changed current truck/bin capability aborts atomically", async () => {
  const fixture = await assignFixture(await createBinDispatchFixture({
    label: "confirm-changed-capability",
    planDate: binDispatchPlanDate(807)
  }));
  await withTransaction(async () => {
    await query(
      `INSERT INTO dispatch_truck_bin_types (truck_id, bin_type_id, active, created_by)
       VALUES ($1, '00000000-0000-4000-8000-000000000020', true, $2)`,
      [fixture.binTruckId, DISPATCHER.operatorId]
    );
    await query(
      "UPDATE dispatch_truck_bin_types SET active = false WHERE truck_id = $1 AND bin_type_id = $2",
      [fixture.binTruckId, fixture.binTypeId]
    );
  });
  const before = await confirmationState(fixture.planId);
  await assert.rejects(
    () => confirmFixture(fixture),
    (error) => hasCode(error, "MBT_BIN_CONFIRMATION_INVALID")
  );
  assert.deepEqual(await confirmationState(fixture.planId), before);
});

test("P3.11 confirmation: an injected failure after the status write rolls back status and Driver projection", async () => {
  const fixture = await assignFixture(await createBinDispatchFixture({
    label: "confirm-rollback",
    planDate: binDispatchPlanDate(808)
  }));
  const before = await confirmationState(fixture.planId);
  const injected = new Error("synthetic P3.11 post-status failure");
  await assert.rejects(
    () => confirmFixture(fixture, {
      hooks: {
        afterStatusUpdate: () => {
          throw injected;
        }
      }
    }),
    (error) => error === injected
  );
  assert.deepEqual(await confirmationState(fixture.planId), before);
});
