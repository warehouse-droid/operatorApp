// @ts-check
import crypto from "node:crypto";
import { query } from "../db.js";
import { canonicalSha256 } from "./canonical-json.js";
import { lockPlanningVisit, planningLoad, planningError, planningEvent, samePlanningValue, readPlanningPlan }
  from "./bin-planning-repository.js";

/** @param {any} visit @param {any} input */
export async function withdrawPlanningAssignment(visit, input) {
  await query(`UPDATE mbt_bin_planning_assignments SET withdrawn_at=now(),withdrawn_by=$2,withdrawal_reason=$3
    WHERE service_visit_id=$1 AND withdrawn_at IS NULL`, [visit.service_visit_id, input.actor.operatorId, input.reason]);
  const stopIds = (visit.dispatch_assignment_snapshot?.stops || []).map((/** @type {any} */ s) => String(s.id));
  await query(`UPDATE driver_job_records SET mbt_assignment_withdrawn_at=COALESCE(mbt_assignment_withdrawn_at,now())
    WHERE plan_id=$1 AND load_id=$2 AND stop_id=ANY($3::text[])`, [visit.dispatch_plan_id, visit.dispatch_load_id, stopIds]);
}

/** @param {string} visitId @param {any} plan @param {any} input @param {boolean} [bumpVisit] */
export async function stagePlanningAssignment(visitId, plan, input, bumpVisit = true) {
  const visit = await lockPlanningVisit(visitId);
  if (["completed", "cancelled"].includes(visit.status)) {
    throw planningError(409, "MBT_BIN_VISIT_COMPLETE", "Completed BIN visits cannot be changed.");
  }
  await withdrawPlanningAssignment(visit, input);
  const { truck, load } = planningLoad(plan, String(visit.dispatch_load_id));
  const generation = Number(visit.planning_generation) + 1;
  const revision = Number(visit.revision) + (bumpVisit ? 1 : 0);
  const steps = await query("SELECT action_code,status FROM mbt_visit_steps WHERE service_visit_id=$1 ORDER BY sequence_number", [visitId]);
  const complete = new Set(steps.rows.filter((/** @type {any} */ s) => ["completed", "skipped"].includes(s.status))
    .map((/** @type {any} */ s) => s.action_code));
  load.stops = (load.stops || []).filter((/** @type {any} */ s) => s.mbt?.visitId !== visitId || !complete.has(s.actionCode))
    .map((/** @type {any} */ s) => s.mbt?.visitId !== visitId ? s : {
      ...s, id: `${String(s.id).replace(/:mbt-g\d+$/u, "")}:mbt-g${generation}`, loadId: String(load.id),
      mbt: { ...s.mbt, planningGeneration: generation, driverReleased: false }
    });
  load.mbtPlanning = true;
  const stops = load.stops.filter((/** @type {any} */ s) => s.mbt?.visitId === visitId);
  if (!stops.length) {throw planningError(409, "MBT_BIN_NO_REMAINING_STEPS", "There are no remaining steps to plan.");}
  const snapshot = { ...visit.dispatch_assignment_snapshot, generation, visitRevision: revision,
    planId: String(plan.id), planDate: plan.planDate, planRevision: plan.revision, loadId: String(load.id),
    truckId: String(truck.id), driverId: String(load.driverId || truck.driverId),
    driverLogin: String(load.driverLogin || truck.driverLogin), stops,
    serviceSnapshotHash: canonicalSha256(visit.service_snapshot) };
  await query(`UPDATE mbt_service_visits SET planning_generation=$2,dispatch_assignment_snapshot=$3::jsonb,
    planned_truck_id=$4,planned_driver_id=$5,dispatch_plan_revision=$6,revision=$7,updated_by=$8,updated_at=now()
    WHERE service_visit_id=$1`, [visitId, generation, JSON.stringify(snapshot), truck.id,
    load.driverId || truck.driverId, plan.revision, revision, input.actor.operatorId]);
  await query(`INSERT INTO mbt_bin_planning_assignments
    (assignment_id,service_visit_id,generation,plan_id,plan_date,load_id,driver_id,truck_id,snapshot,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`, [crypto.randomUUID(), visitId, generation,
    plan.id, plan.planDate, load.id, load.driverId || truck.driverId, truck.id, JSON.stringify(snapshot), input.actor.operatorId]);
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1", [plan.id, JSON.stringify(plan.trucks)]);
  await planningEvent(visitId, "assignment_staged", input.actor.operatorId, { generation, planId: plan.id, loadId: load.id });
  return { visitRevision: revision, generation, stops };
}

/** @param {any} visit @param {any} group @param {any} plan */
export async function validatePlanningAssignment(visit, group, plan) {
  const { rows } = await query(`SELECT a.*,d.login,d.active AS driver_active,t.active AS truck_active,
      t.truck_type,t.bin_service_enabled,t.bin_slot_capacity,t.capacity_lbs,t.base_yard_id,
      v.revision AS template_revision
    FROM mbt_bin_planning_assignments a JOIN dispatch_drivers d ON d.id=a.driver_id
    JOIN dispatch_trucks t ON t.id=a.truck_id
    JOIN mbt_service_template_versions v ON v.template_version_id=$3
    WHERE a.service_visit_id=$1 AND a.generation=$2 AND a.withdrawn_at IS NULL FOR UPDATE OF a,d,t`,
  [visit.service_visit_id, visit.planning_generation, visit.service_template_version_id]);
  const current = rows[0];
  const snapshot = visit.dispatch_assignment_snapshot;
  const supported = await query("SELECT 1 FROM dispatch_truck_bin_types WHERE truck_id=$1 AND bin_type_id=$2 AND active", [visit.planned_truck_id, visit.bin_type_id]);
  if (!current || !matchesAssignmentIdentity(current, visit, group, plan)
      || !matchesAssignmentEvidence(current, visit, group)
      || !supported.rowCount) {
    throw planningError(409, "MBT_BIN_CONFIRMATION_INVALID", "A BIN assignment changed. Refresh and check the visit.", { visitId: visit.service_visit_id });
  }
  await validateAssignmentReservations(visit, current, snapshot);
  return current;
}

/** @param {any} current @param {any} visit @param {any} group @param {any} plan */
function matchesAssignmentIdentity(current, visit, group, plan) {
  const actual = [current.plan_id, visit.dispatch_plan_id, current.load_id, visit.dispatch_load_id,
    current.truck_id, visit.planned_truck_id, visit.planned_driver_id, current.driver_id];
  const expected = [plan.id, plan.id, group.load.id, group.load.id, group.truck.id, current.truck_id,
    current.driver_id, group.load.driverId || group.truck.driverId];
  return samePlanningValue(actual.map(String), expected.map(String))
    && String(current.login).toLowerCase() === String(group.load.driverLogin || group.truck.driverLogin).toLowerCase();
}
/** @param {any} current @param {any} visit @param {any} group */
function matchesAssignmentEvidence(current, visit, group) {
  const snapshot = visit.dispatch_assignment_snapshot;
  return samePlanningValue(current.snapshot, snapshot) && samePlanningValue(snapshot.stops, group.stops)
    && snapshot.serviceSnapshotHash === canonicalSha256(visit.service_snapshot)
    && Number(current.template_revision) === Number(snapshot.templateRevision)
    && current.driver_active && current.truck_active && current.truck_type === "bin" && current.bin_service_enabled;
}
/** @param {any} visit @param {any} current @param {any} snapshot */
async function validateAssignmentReservations(visit, current, snapshot) {
  if (visit.status !== "completed") {
    const active = await query("SELECT reservation_id::text,asset_id::text,reservation_slot FROM mbt_bin_asset_reservations WHERE visit_id=$1 AND released_at IS NULL ORDER BY reservation_slot", [visit.service_visit_id]);
    const expected = [...snapshot.assetReservations].sort((a, b) => a.reservationSlot.localeCompare(b.reservationSlot));
    if (!samePlanningValue(active.rows.map((/** @type {any} */ r) => ({ reservationId: r.reservation_id, assetId: r.asset_id, reservationSlot: r.reservation_slot })), expected)) {
      throw planningError(409, "MBT_BIN_CONFIRMATION_INVALID", "The BIN reservations changed. Refresh before confirming.");
    }
  } else if (!current.released_at) {
    throw planningError(409, "MBT_BIN_CONFIRMATION_INVALID", "An unreleased assignment cannot be completed.");
  }
}

/** @param {any} plan */
export function pendingPlanningReturns(plan) {
  return plan.trucks.flatMap((/** @type {any} */ truck) => truck.loads || [])
    .filter((/** @type {any} */ load) => load.mbtPlanning && load.returnOnly && load.mbtReturnReleased !== true);
}

/** @param {string} planId @param {string} actorId @param {number} previousRevision */
export async function publishPlanningAssignments(planId, actorId, previousRevision) {
  const plan = await readPlanningPlan(planId);
  const pending = await query(`SELECT * FROM mbt_bin_planning_assignments WHERE plan_id=$1
    AND withdrawn_at IS NULL AND released_at IS NULL ORDER BY service_visit_id FOR UPDATE`, [planId]);
  for (const row of pending.rows) {
    const { load } = planningLoad(plan, row.load_id);
    const stops = load.stops.filter((/** @type {any} */ s) => s.mbt?.visitId === String(row.service_visit_id));
    for (const stop of stops) {stop.mbt.driverReleased = true;}
    const snapshot = { ...row.snapshot, stops };
    await query(`UPDATE mbt_bin_planning_assignments SET released_at=now(),released_by=$2,snapshot=$3::jsonb WHERE assignment_id=$1`, [row.assignment_id, actorId, JSON.stringify(snapshot)]);
    await query("UPDATE mbt_service_visits SET dispatch_assignment_snapshot=$2::jsonb WHERE service_visit_id=$1", [row.service_visit_id, JSON.stringify(snapshot)]);
    await planningEvent(row.service_visit_id, "assignment_released", actorId, { generation: Number(row.generation), planId });
  }
  const returns = pendingPlanningReturns(plan);
  for (const load of returns) {load.mbtReturnReleased = true;}
  if (pending.rowCount || returns.length) {
    await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb,saved_at=now() WHERE plan_id=$1", [planId, JSON.stringify(plan.trucks)]);
    if (plan.revision === previousRevision) {await query("UPDATE dispatch_plans SET revision=revision+1,updated_at=now() WHERE id=$1", [planId]);}
  }
  return readPlanningPlan(planId);
}
