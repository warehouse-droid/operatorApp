// @ts-check
import crypto from "node:crypto";
import { query } from "../db.js";
import { persistedDispatchPlan } from "../dispatch-plan-fence.js";
import { assertDispatchExecutedPrefixPreserved } from "../dispatch-executed-prefix-repository.js";
import { syncDispatchPlanLoadAssignments } from "../dispatch-load-assignment-repository.js";
import { syncDispatchPlanOrderAssignments, syncDispatchPlanRelationEdges } from "../dispatch-planner-v2-repository.js";
import { dispatchLoadAssignment, validateDispatchLoadAssignments } from "../dispatch-load-assignment.js";
import { MbtError } from "./errors.js";
import { canonicalSha256 } from "./canonical-json.js";

/** @param {number} status @param {string} code @param {string} message @param {any} [details] */
export function planningError(status, code, message, details = {}) {
  return new MbtError({ status, code, message, details });
}
/** @param {unknown} value @param {string} label */
export function planningText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) {throw planningError(400, "MBT_BIN_DISPATCH_INPUT_INVALID", `${label} is required.`);}
  return text;
}
/** @param {any} input @param {any} boundary @param {boolean} [write] */
export function assertPlanningAccess(input, boundary, write = false) {
  const c = boundary?.capability;
  if (!c?.environmentEnabled || !c?.databaseEnabled || !c?.pilotAuthorized) {
    throw planningError(409, "MBT_CAPABILITY_DISABLED", "MBT BIN Planning is disabled.");
  }
  if (write) {assertPlanningActor(input.actor);}
}
/** @param {any} actor */
function assertPlanningActor(actor) {
  if (!actor?.operatorId || !actor.roles?.some((/** @type {string} */ r) => ["admin", "dispatcher"].includes(r))) {
    throw planningError(403, "MBT_FORBIDDEN", "Dispatcher or Admin access is required.");
  }
}
/** @param {unknown} value */
export function planningDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`))
      || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw planningError(400, "MBT_BIN_DISPATCH_INPUT_INVALID", "A valid plan date is required.");
  }
  return date;
}
/** @param {string} planId */
export async function readPlanningPlan(planId) {
  const { rows } = await query(`SELECT p.*,s.orders,s.trucks,s.summary,s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [planId]);
  const plan = persistedDispatchPlan(rows[0]);
  if (!plan) {throw planningError(404, "DISPATCH_PLAN_NOT_FOUND", "The daily plan was not found.");}
  return plan;
}
/** @param {string} visitId @param {number | undefined} [revision] */
export async function lockPlanningVisit(visitId, revision) {
  const { rows } = await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1 FOR UPDATE", [visitId]);
  const visit = rows[0];
  if (!visit) {throw planningError(404, "MBT_BIN_VISIT_NOT_FOUND", "The BIN visit was not found.");}
  if (revision !== undefined && (!Number.isSafeInteger(revision) || Number(visit.revision) !== revision)) {
    throw planningError(409, "MBT_BIN_DISPATCH_STALE_REVISION", "The BIN visit changed. Refresh before retrying.");
  }
  return visit;
}
/** @param {any} plan @param {string} loadId */
export function planningLoad(plan, loadId) {
  for (const truck of plan.trucks || []) {
    const load = truck.loads?.find((/** @type {any} */ l) => String(l.id) === loadId);
    if (load) {return { truck, load };}
  }
  throw planningError(404, "MBT_BIN_DISPATCH_LOAD_NOT_FOUND", "The load was not found.");
}
/** @param {any} plan @param {string} visitId */
export function removePlanningVisit(plan, visitId) {
  for (const truck of plan.trucks) {
    for (const load of truck.loads || []) {
      load.stops = (load.stops || []).filter((/** @type {any} */ s) => s.mbt?.visitId !== visitId);
    }
  }
}
/** @param {any} previous @param {any} next @param {string[]} [withdrawnVisitIds] */
export async function persistPlanningPlan(previous, next, withdrawnVisitIds = []) {
  // Only explicitly withdrawn BIN groups are excluded from the active prefix.
  // Their original route remains in assignment history and driver evidence.
  const comparison = structuredClone(previous);
  for (const id of withdrawnVisitIds) {removePlanningVisit(comparison, id);}
  await assertDispatchExecutedPrefixPreserved({ previousPlan: comparison, nextPlan: next,
    execute: async (/** @type {string} */ sql, /** @type {any[]} */ params = []) => {
      const result = await query(sql, params);
      const withdrawnStops = new Set(previous.trucks.flatMap((/** @type {any} */ t) => t.loads || [])
        .flatMap((/** @type {any} */ l) => l.stops || [])
        .filter((/** @type {any} */ s) => withdrawnVisitIds.includes(s.mbt?.visitId))
        .map((/** @type {any} */ s) => String(s.id)));
      return { ...result, rows: result.rows.filter((/** @type {any} */ r) => !withdrawnStops.has(String(r.stop_id))) };
    } });
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb,saved_at=now() WHERE plan_id=$1", [previous.id, JSON.stringify(next.trucks)]);
  await query("UPDATE dispatch_plans SET revision=revision+1,updated_at=now() WHERE id=$1", [previous.id]);
  return readPlanningPlan(previous.id);
}
/** @param {any} plan */
export async function syncPlanningProjections(plan) {
  await syncDispatchPlanLoadAssignments(plan, { allowBin: true });
  await syncDispatchPlanOrderAssignments(plan);
  await syncDispatchPlanRelationEdges(plan);
}
/** @param {any} plan @param {boolean} [confirm] */
export function assertPlanningSchedule(plan, confirm = false) {
  const conflicts = validateDispatchLoadAssignments(plan, { requireAssignments: confirm, includeEmptyBinLoads: true });
  const first = conflicts[0];
  if (first) {
    throw planningError(409, first.code, first.message, { conflicts });
  }
  for (const truck of plan.trucks) {
    for (const load of truck.loads || []) {
      if (!load.stops?.some((/** @type {any} */ s) => s.mbt)) {continue;}
      const timing = dispatchLoadAssignment(truck, load);
      if (!timing.driverLogin || timing.plannedStartMinute === null || timing.plannedFinishMinute === null
          || timing.plannedFinishMinute <= timing.plannedStartMinute) {
        throw planningError(409, "MBT_BIN_LOAD_TIME_REQUIRED", "Every BIN load needs a driver, start and finish time.");
      }
    }
  }
}
/** @param {any} visit @param {any} input @param {string} action @param {any} prior @param {any} assignment @param {number} planRevision */
export async function planningHistory(visit, input, action, prior, assignment, planRevision) {
  await query(`INSERT INTO mbt_bin_dispatch_assignment_history
    (assignment_history_id,service_visit_id,contract_id,dispatch_plan_id,action,prior_assignment,assignment,
      visit_revision,plan_revision,actor_operator_id,reason,idempotency_key)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)`,
  [crypto.randomUUID(), visit.service_visit_id, visit.contract_id, input.planId, action, JSON.stringify(prior),
    assignment ? JSON.stringify(assignment) : null, Number(visit.revision), planRevision, input.actor.operatorId,
    input.reason, `${input.idempotencyKey}:${visit.service_visit_id}`]);
}
/** @param {string} visitId @param {string} action @param {string} actorId @param {any} details */
export async function planningEvent(visitId, action, actorId, details) {
  await query(`INSERT INTO mbt_bin_planning_events (event_id,service_visit_id,action,actor_id,details)
    VALUES ($1,$2,$3,$4,$5::jsonb)`, [crypto.randomUUID(), visitId, action, actorId, JSON.stringify(details)]);
}
/** @param {string} visitId @param {string} actorId */
export async function releaseMbtBinSuccessorToPool(visitId, actorId) {
  const { rows } = await query(`UPDATE mbt_service_visits successor
    SET status='ready',revision=successor.revision+1,updated_by=$2,updated_at=now()
    FROM mbt_service_visits completed
    WHERE completed.service_visit_id=$1 AND completed.status='completed'
      AND successor.predecessor_visit_id=completed.service_visit_id
      AND successor.contract_id=completed.contract_id
      AND successor.service_line_id IS NOT DISTINCT FROM completed.service_line_id
      AND successor.status='tentative' AND successor.dispatch_plan_id IS NULL
    RETURNING successor.service_visit_id`, [visitId, actorId]);
  for (const row of rows) {
    await planningEvent(String(row.service_visit_id), "available_in_pool", actorId, { predecessorVisitId: visitId });
  }
  return rows.map((/** @type {any} */ row) => String(row.service_visit_id));
}
/** @param {any} value @param {any} other */
export function samePlanningValue(value, other) {return canonicalSha256(value) === canonicalSha256(other);}
