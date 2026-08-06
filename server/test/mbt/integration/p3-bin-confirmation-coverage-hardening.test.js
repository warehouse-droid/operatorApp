// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  advanceMbtBinContractLeg,
  assignMbtBinFrontLeg,
  confirmMbtBinDispatchPlan
} from "../../../src/mbt/bin-dispatch-service.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  binAssignmentCommand,
  binDispatchPlanDate,
  createBinDispatchFixture,
  enabledBinDispatchBoundary
} from "../support/bin-dispatch-fixtures.js";

const DISPATCHER = Object.freeze({
  operatorId: "p3-coverage-bin-dispatcher",
  roles: Object.freeze(["dispatcher"])
});

after(closeDb);

/** @param {unknown} error @param {number} status @param {string} code @param {string} [reason] */
function exactMbtFailure(error, status, code, reason = "") {
  return error instanceof MbtError
    && error.status === status
    && error.code === code
    && (!reason || error.details?.reason === reason);
}

/** @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture */
async function assignedFixture(fixture) {
  await assignMbtBinFrontLeg(binAssignmentCommand(fixture, "coverage-hardening"), {
    capability: enabledBinDispatchBoundary
  });
  return fixture;
}

/** @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture */
function confirmFixture(fixture) {
  return confirmMbtBinDispatchPlan({
    actor: DISPATCHER,
    planId: fixture.planId,
    note: "Coverage hardening confirmation"
  }, { capability: enabledBinDispatchBoundary });
}

/**
 * Capture every durable row that confirmation is allowed to change, plus the
 * authority rows deliberately corrupted by a test. JSON aggregation keeps the
 * comparison deterministic without depending on process-global row counts.
 * @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture
 */
async function confirmationFootprint(fixture) {
  const plan = await query(
    `SELECT plan.status, plan.revision::int, snapshot.trucks,
            (SELECT count(*)::int
               FROM dispatch_plan_load_assignments assignment
              WHERE assignment.plan_id = plan.id) AS load_assignment_count
       FROM dispatch_plans plan
       JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
      WHERE plan.id = $1`,
    [fixture.planId]
  );
  const visits = await query(
    `SELECT service_visit_id::text, status, revision::int,
            dispatch_plan_id, dispatch_plan_revision::int, dispatch_load_id,
            dispatch_assignment_snapshot, planned_truck_id::text,
            planned_driver_id::text, scheduled_start_at, scheduled_end_at
       FROM mbt_service_visits
      WHERE contract_id = $1
      ORDER BY visit_number, service_visit_id`,
    [fixture.contractId]
  );
  const reservations = await query(
    `SELECT reservation_id::text, reservation_slot, asset_id::text,
            contract_id::text, visit_id::text, released_at, revision::int
       FROM mbt_bin_asset_reservations
      WHERE visit_id = $1
      ORDER BY reservation_slot, reservation_id`,
    [fixture.frontVisitId]
  );
  const evidenceRequirements = await query(
    `SELECT evidence_code, evidence_type, minimum_count::int, required,
            status, revision::int
       FROM mbt_visit_evidence_requirements
      WHERE service_visit_id = $1
      ORDER BY evidence_code`,
    [fixture.frontVisitId]
  );
  const authority = await query(
    `SELECT template.revision::int AS template_revision,
            driver.active AS driver_active,
            truck.active AS truck_active,
            truck.truck_type, truck.bin_service_enabled,
            truck.bin_slot_capacity::int
       FROM mbt_service_visits visit
       JOIN mbt_service_template_versions template
         ON template.template_version_id = visit.service_template_version_id
       JOIN dispatch_drivers driver ON driver.id = visit.planned_driver_id
       JOIN dispatch_trucks truck ON truck.id = visit.planned_truck_id
      WHERE visit.service_visit_id = $1`,
    [fixture.frontVisitId]
  );
  const effects = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_bin_dispatch_assignment_history history
         WHERE history.service_visit_id = $1) AS assignment_history_count,
       (SELECT count(*)::int
          FROM mbt_command_receipts receipt
         WHERE receipt.command_name LIKE 'mbt.bin_dispatch.%'
           AND receipt.entity_id = $1::text) AS receipt_count,
       (SELECT count(*)::int
          FROM mbt_audit_events audit
         WHERE audit.entity_type = 'mbt_service_visit'
           AND audit.entity_id = $1::text) AS audit_count`,
    [fixture.frontVisitId]
  );
  return {
    plan: plan.rows[0],
    visits: visits.rows,
    reservations: reservations.rows,
    evidenceRequirements: evidenceRequirements.rows,
    authority: authority.rows[0],
    effects: effects.rows[0]
  };
}

/**
 * @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture
 * @param {string} reason
 */
async function assertConfirmationRejectedWithoutWrites(fixture, reason) {
  const before = await confirmationFootprint(fixture);
  await assert.rejects(
    () => confirmFixture(fixture),
    (error) => exactMbtFailure(error, 409, "MBT_BIN_CONFIRMATION_INVALID", reason)
  );
  assert.deepEqual(await confirmationFootprint(fixture), before);
}

/** @param {string} label @param {number} dateOffset */
async function newAssignedFixture(label, dateOffset) {
  return assignedFixture(await createBinDispatchFixture({
    label,
    planDate: binDispatchPlanDate(dateOffset)
  }));
}

test("P3 coverage: an invalid persisted plan status cannot partially confirm", async () => {
  const fixture = await newAssignedFixture("coverage-invalid-plan-status", 31_000);
  await query("UPDATE dispatch_plans SET status = 'archived' WHERE id = $1", [fixture.planId]);
  await assertConfirmationRejectedWithoutWrites(fixture, "plan_status_invalid");
});

test("P3 coverage: an extra visit linked to the plan fails the exact group-set guard atomically", async () => {
  const fixture = await newAssignedFixture("coverage-visit-group-set", 31_001);
  await query(
    "UPDATE mbt_service_visits SET dispatch_plan_id = $2 WHERE service_visit_id = $1",
    [fixture.successorVisitId, fixture.planId]
  );
  await assertConfirmationRejectedWithoutWrites(fixture, "visit_group_set_mismatch");
});

test("P3 coverage: a changed projected driver fails before current fleet capability is trusted", async () => {
  const fixture = await newAssignedFixture("coverage-driver-projection", 31_002);
  const selected = await query(
    "SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
    [fixture.planId]
  );
  const trucks = structuredClone(selected.rows[0].trucks);
  const truck = trucks.find((candidate) => String(candidate.id) === fixture.binTruckId);
  const load = truck.loads.find((candidate) => String(candidate.id) === fixture.binLoadIds[0]);
  load.driverId = fixture.flatbedTruckId;
  await query(
    "UPDATE dispatch_plan_snapshots SET trucks = $2::jsonb WHERE plan_id = $1",
    [fixture.planId, JSON.stringify(trucks)]
  );
  await assertConfirmationRejectedWithoutWrites(fixture, "truck_driver_assignment_mismatch");
});

test("P3 coverage: a corrupted frozen template revision cannot pass current template validation", async () => {
  const fixture = await newAssignedFixture("coverage-template-revision", 31_003);
  const selected = await query(
    "SELECT dispatch_assignment_snapshot FROM mbt_service_visits WHERE service_visit_id = $1",
    [fixture.frontVisitId]
  );
  const assignment = structuredClone(selected.rows[0].dispatch_assignment_snapshot);
  assignment.templateRevision = Number(assignment.templateRevision) + 1;
  await query(
    `UPDATE mbt_service_visits
        SET dispatch_assignment_snapshot = $2::jsonb
      WHERE service_visit_id = $1`,
    [fixture.frontVisitId, JSON.stringify(assignment)]
  );
  await assertConfirmationRejectedWithoutWrites(fixture, "visit_template_mismatch");
});

test("P3 coverage: changed evidence cardinality invalidates materialized stops without status writes", async () => {
  const fixture = await newAssignedFixture("coverage-stop-evidence", 31_004);
  await query(
    `UPDATE mbt_visit_evidence_requirements
        SET minimum_count = minimum_count + 1, revision = revision + 1,
            updated_at = now()
      WHERE service_visit_id = $1 AND evidence_code = 'outgoing_bin_scan'`,
    [fixture.frontVisitId]
  );
  await assertConfirmationRejectedWithoutWrites(fixture, "visit_assignment_mismatch");
});

test("P3 coverage: a missing reservation in the frozen snapshot is distinguished from ledger drift", async () => {
  const fixture = await newAssignedFixture("coverage-reservation-snapshot", 31_005);
  const selected = await query(
    "SELECT dispatch_assignment_snapshot FROM mbt_service_visits WHERE service_visit_id = $1",
    [fixture.frontVisitId]
  );
  const assignment = structuredClone(selected.rows[0].dispatch_assignment_snapshot);
  assignment.assetReservations = [];
  await query(
    `UPDATE mbt_service_visits
        SET dispatch_assignment_snapshot = $2::jsonb
      WHERE service_visit_id = $1`,
    [fixture.frontVisitId, JSON.stringify(assignment)]
  );
  await assertConfirmationRejectedWithoutWrites(fixture, "required_reservation_snapshot_mismatch");
});

test("P3 coverage: reservation-ledger slot drift cannot be hidden by a valid frozen snapshot", async () => {
  const fixture = await newAssignedFixture("coverage-reservation-ledger", 31_006);
  await query(
    `UPDATE mbt_bin_asset_reservations
        SET reservation_slot = 'incoming', updated_at = now()
      WHERE visit_id = $1 AND released_at IS NULL`,
    [fixture.frontVisitId]
  );
  await assertConfirmationRejectedWithoutWrites(fixture, "active_reservation_mismatch");
});

test("P3 coverage: a driver disabled after assignment fails current capability without confirmation writes", async () => {
  const fixture = await newAssignedFixture("coverage-inactive-driver", 31_007);
  await query("UPDATE dispatch_drivers SET active = false WHERE id = $1", [fixture.driverId]);
  await assertConfirmationRejectedWithoutWrites(fixture, "truck_capability_mismatch");
});

test("P3 coverage: advancing a missing contract leaves no command receipt, audit, or plan mutation", async () => {
  const fixture = await createBinDispatchFixture({
    label: "coverage-missing-advance-contract",
    planDate: binDispatchPlanDate(31_008)
  });
  const identity = crypto.randomUUID();
  const idempotencyKey = `p3-coverage-missing-contract-${identity}`;
  const correlationId = `p3-coverage-missing-contract-correlation-${identity}`;
  const requestId = `p3-coverage-missing-contract-request-${identity}`;
  const before = await confirmationFootprint(fixture);

  await assert.rejects(
    () => advanceMbtBinContractLeg({
      actor: DISPATCHER,
      contractId: crypto.randomUUID(),
      completedVisitId: crypto.randomUUID(),
      expectedCompletedVisitRevision: 1,
      nextVisitId: crypto.randomUUID(),
      expectedNextVisitRevision: 1,
      planId: fixture.planId,
      expectedPlanRevision: 1,
      reason: "Reject an advancement for a missing contract",
      idempotencyKey,
      correlationId,
      requestId
    }, { capability: enabledBinDispatchBoundary }),
    (error) => exactMbtFailure(error, 404, "MBT_BIN_CONTRACT_NOT_FOUND")
  );

  assert.deepEqual(await confirmationFootprint(fixture), before);
  const sideEffects = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1 AND command_name = 'mbt.bin_dispatch.advance'
           AND idempotency_key = $2) AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE correlation_id = $3 OR request_id = $4) AS audits`,
    [DISPATCHER.operatorId, idempotencyKey, correlationId, requestId]
  );
  assert.deepEqual(sideEffects.rows[0], { receipts: 0, audits: 0 });
});
