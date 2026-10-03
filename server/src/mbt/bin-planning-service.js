// @ts-check
import crypto from "node:crypto";
import { query, afterTransactionCommit } from "../db.js";
import { withDispatchPlanWrite } from "../dispatch-plan-write.js";
import { confirmDispatchPlan } from "../dispatch-plan-repository.js";
import { dispatchLoadAssignment } from "../dispatch-load-assignment.js";
import { insertMbtAuditEvent } from "./audit-repository.js";
import { assignMbtBinFrontLeg, confirmMbtBinDispatchPlan } from "./bin-dispatch-service.js";
import { assertPlanningCapacity } from "./bin-planning-capacity.js";
import { stagePlanningAssignment, withdrawPlanningAssignment, publishPlanningAssignments } from "./bin-planning-assignments.js";
import { releasePlanningReservations } from "./bin-planning-reservations.js";
import { sequenceBinVisit, binVisitGroups } from "./bin-planning-domain.js";
import { binDispatchOrders } from "./dispatch-bin-safety.js";
import { saveBinPlanningBoard, binBoardLoadFields, isBinBoardLoad } from "./bin-planning-board.js";
import { MbtError } from "./errors.js";
import { assertPlanningAccess, planningText, planningDate, planningError, readPlanningPlan,
  lockPlanningVisit, planningLoad, removePlanningVisit, persistPlanningPlan, syncPlanningProjections,
  assertPlanningSchedule, planningHistory, releaseMbtBinSuccessorToPool } from "./bin-planning-repository.js";
export { getMbtBinPlanning, getMbtBinPlanningVisit } from "./bin-planning-read.js";

/** @param {any} visit @param {any} input */
function assertAssignedHere(visit, input) {
  if (["completed", "cancelled"].includes(visit.status)) {
    throw planningError(409, "MBT_BIN_VISIT_COMPLETE", "Completed BIN visits cannot be unplanned or changed.");
  }
  if (String(visit.dispatch_plan_id || "") !== String(input.planId)) {
    throw planningError(409, "MBT_BIN_DISPATCH_STALE_REVISION", "The BIN assignment changed. Refresh before retrying.");
  }
}

/** @param {any} input */
async function cancelVisit(input) {
  const visit = await lockPlanningVisit(input.visitId, input.expectedVisitRevision);
  assertAssignedHere(visit, input);
  const previous = await readPlanningPlan(input.planId);
  const next = structuredClone(previous);
  removePlanningVisit(next, input.visitId);
  await withdrawPlanningAssignment(visit, input);
  await releasePlanningReservations(visit, input);
  const saved = await persistPlanningPlan(previous, next, [input.visitId]);
  const updated = await query(`UPDATE mbt_service_visits SET dispatch_plan_id=NULL,dispatch_load_id=NULL,
    dispatch_plan_revision=NULL,dispatch_assignment_snapshot=NULL,planned_truck_id=NULL,planned_driver_id=NULL,
    status=CASE WHEN actual_started_at IS NULL THEN 'ready' ELSE status END,
    revision=revision+1,updated_by=$2,updated_at=now() WHERE service_visit_id=$1 RETURNING *`, [input.visitId, input.actor.operatorId]);
  await planningHistory(updated.rows[0], input, "cancelled_assignment", visit.dispatch_assignment_snapshot, null, saved.revision);
  return { visitId: input.visitId, visitRevision: Number(updated.rows[0].revision), priorAssignment: visit.dispatch_assignment_snapshot };
}

/** @param {any} input @param {any} boundary @param {any[]} [stopOverrides] @param {any[]} [stopTimings] */
async function assignVisit(input, boundary, stopOverrides = [], stopTimings = []) {
  const visit = await lockPlanningVisit(input.visitId, input.expectedVisitRevision);
  const plan = await readPlanningPlan(input.planId);
  const { truck, load } = planningLoad(plan, input.loadId);
  if ((load.stops || []).some((/** @type {any} */ s) => !s.mbt?.visitId)) {
    throw planningError(409, "MBT_BIN_LOAD_REQUIRED", "Choose a BIN-only load.");
  }
  const timing = dispatchLoadAssignment(truck, load);
  if (timing.plannedStartMinute === null || timing.plannedFinishMinute === null) {
    throw planningError(409, "MBT_BIN_LOAD_TIME_REQUIRED", "Set the BIN load start and finish time first.");
  }
  const assets = await planningAssets(input, visit);
  const window = await query(`SELECT (($1::date+$2::int*interval '1 minute') AT TIME ZONE 'America/Toronto') AS start,
    (($1::date+$3::int*interval '1 minute') AT TIME ZONE 'America/Toronto') AS finish`, [plan.planDate, timing.plannedStartMinute, timing.plannedFinishMinute]);
  const result = await assignMbtBinFrontLeg({ ...input, assetAssignments: assets, expectedPlanRevision: plan.revision,
    reservationStartAt: window.rows[0].start, reservationEndAt: window.rows[0].finish }, { ...boundary, planning: true });
  const saved = await readPlanningPlan(input.planId);
  applyPlanningStopOverrides(saved, input, stopOverrides);
  applyPlanningStopTimings(saved, input, stopTimings, visit);
  const staged = await stagePlanningAssignment(input.visitId, saved, input, false);
  return { ...result.body, ...staged };
}

/** @param {any} plan @param {any} input @param {any[]} stopTimings @param {any} visit */
function applyPlanningStopTimings(plan, input, stopTimings, visit) {
  const assigned = planningLoad(plan, input.loadId).load;
  const site = visit.site_snapshot || {};
  const address = [site.addressLine1, site.city, site.region].filter(Boolean).join(", ");
  for (const stop of assigned.stops.filter((/** @type {any} */ s) => s.mbt?.visitId === input.visitId)) {
    stop.planningAddress = String(stop.yardCode || address);
  }
  for (const row of stopTimings) {
    const stop = assigned.stops.find((/** @type {any} */ s) => s.mbt?.visitId === input.visitId && Number(s.mbt.stopSequence) === row.sequence);
    if (!stop || row.arrival < assigned.plannedStartMinute || row.depart > assigned.plannedFinishMinute) {
      throw planningError(409, "MBT_BIN_BOARD_INVALID", "BIN step timing must fit its load and required steps.");
    }
    stop.timing = { arrival: row.arrival, depart: row.depart };
  }
}

/** @param {any} input @param {any} visit */
async function planningAssets(input, visit) {
  let assets = input.assetAssignments || [];
  if (!assets.length && (visit.expected_asset_id || visit.outgoing_asset_id)) {
    const assetId = visit.expected_asset_id || visit.outgoing_asset_id;
    const ids = [{ assetId, reservationSlot: "outgoing" }];
    if (visit.incoming_asset_id && visit.incoming_asset_id !== assetId) {ids.push({ assetId: visit.incoming_asset_id, reservationSlot: "incoming" });}
    const states = await query("SELECT asset_id,revision::int FROM mbt_bin_asset_state WHERE asset_id=ANY($1::uuid[]) ORDER BY asset_id FOR UPDATE", [ids.map(i => i.assetId)]);
    assets = ids.map(id => ({ ...id, expectedStateRevision: states.rows.find((/** @type {any} */ r) => r.asset_id === id.assetId)?.revision }));
  }
  return assets;
}

/** @param {any} plan @param {any} input @param {any[]} stopOverrides */
function applyPlanningStopOverrides(plan, input, stopOverrides) {
  const assigned = planningLoad(plan, input.loadId).load;
  for (const override of stopOverrides) {
    const stop = assigned.stops.find((/** @type {any} */ s) => s.mbt?.visitId === input.visitId && Number(s.mbt.stopSequence) === override.sequence);
    if (!stop) {throw planningError(409, "MBT_BIN_BOARD_INVALID", "The required BIN steps changed. Refresh before retrying.");}
    stop.stopTimeOverrideMinutes = override.minutes;
  }
}

/** @param {any} input */
async function selectedFleet(input) {
  const driver = (await query("SELECT id::text,name,login FROM dispatch_drivers WHERE id=$1 AND active FOR UPDATE", [input.driverId])).rows[0];
  const truck = (await query(`SELECT t.id::text,t.plate,t.truck_type AS "truckType",t.capacity_lbs::float AS "capacityLbs",
    t.bin_slot_capacity AS "binSlotCapacity",t.base_yard_id::text AS "baseYardId",COALESCE(y.yard_code,t.base_yard) AS base,
    ARRAY(SELECT b.type_code FROM dispatch_truck_bin_types c JOIN mbt_bin_types b ON b.bin_type_id=c.bin_type_id
      WHERE c.truck_id=t.id AND c.active AND b.active ORDER BY b.type_code) AS "supportedBinTypeCodes"
    FROM dispatch_trucks t LEFT JOIN mbt_yards y ON y.yard_id=t.base_yard_id
    WHERE t.id=$1 AND t.active AND t.truck_type='bin' AND t.bin_service_enabled FOR UPDATE OF t`, [input.truckId])).rows[0];
  if (!driver || !truck) {throw planningError(409, "MBT_BIN_TRUCK_REQUIRED", "Choose an active driver and compatible BIN truck.");}
  return { driver, truck };
}

/** @param {any} input @param {any} [options] */
async function saveLoad(input, options = {}) {
  assertDraftLoadTimes(input, options);
  const previous = await readPlanningPlan(input.planId);
  const next = structuredClone(previous);
  const fleet = await selectedFleet(input);
  const old = input.loadId ? planningLoad(next, input.loadId) : null;
  assertEditableLoad(old);
  const loadId = input.loadId || options.newLoadId || `MBT-${crypto.randomUUID()}`;
  const load = old?.load || { id: loadId, stops: [] };
  const ids = binVisitGroups(load.stops || []).map(g => g.visitId);
  for (const id of [...ids].sort()) {assertAssignedHere(await lockPlanningVisit(id), input);}
  placePlanningLoad(next, old, load, input, fleet, options);
  const saved = await persistPlanningPlan(previous, next);
  for (const id of ids) {
    const visit = await lockPlanningVisit(id);
    const staged = await stagePlanningAssignment(id, saved, input);
    await planningHistory({ ...visit, revision: staged.visitRevision }, input, "load_changed", visit.dispatch_assignment_snapshot,
      (await lockPlanningVisit(id)).dispatch_assignment_snapshot, saved.revision);
  }
  return { loadId };
}

/** @param {any} input @param {any} options */
function assertDraftLoadTimes(input, options) {
  if (options.empty && input.plannedFinishMinute === null) {
    if (!Number.isInteger(input.plannedStartMinute) || input.plannedStartMinute < 0 || input.plannedStartMinute >= 1440) {
      throw planningError(400, "MBT_BIN_LOAD_TIME_REQUIRED", "Choose a valid start time within the plan day.");
    }
  } else {assertLoadTimes(input);}
}
/** @param {any} next @param {any} old @param {any} load @param {any} input @param {any} fleet @param {any} options */
function placePlanningLoad(next, old, load, input, fleet, options) {
  const loadId = load.id;
  const oldIndex = old?.truck.loads.findIndex((/** @type {any} */ l) => l.id === loadId) ?? -1;
  if (old) {old.truck.loads = old.truck.loads.filter((/** @type {any} */ l) => l.id !== loadId);}
  let target = planningFleetTruck(next, fleet.truck, options.board);
  if (!target) {target = { ...fleet.truck, loads: [] }; next.trucks.push(target);}
  Object.assign(load, loadFields(input, fleet, load));
  if (options.board) {
    Object.assign(load, binBoardLoadFields(input));
    if (typeof input.truckStartYard === "string") {target.base = input.truckStartYard;}
  }
  if (load.returnOnly) {load.mbtReturnReleased = false;}
  if (old && target === old.truck) {target.loads.splice(oldIndex, 0, load);}
  else {target.loads.push(load);}
}

/** Dispatch's empty saved trucks can use display IDs such as T1. Reuse the
 * BIN-only truck container while resolving its physical fleet identity.
 * @param {any} plan @param {any} truck @param {boolean} board */
function planningFleetTruck(plan, truck, board) {
  const existing = plan.trucks.find((/** @type {any} */ t) => String(t.id) === truck.id);
  if (existing || !board) {return existing;}
  const alias = plan.trucks.find((/** @type {any} */ t) => String(t.plate).toUpperCase() === String(truck.plate).toUpperCase());
  if (!alias) {return null;}
  if (alias.loads.some((/** @type {any} */ load) => !isBinBoardLoad(alias, load))) {
    throw planningError(409, "MBT_BIN_LOAD_REQUIRED", "This truck has ordinary Dispatch work. Preserve its existing schedule.");
  }
  alias.id = truck.id;
  return alias;
}

/** @param {any} input */
function assertLoadTimes(input) {
  const start = input.plannedStartMinute; const finish = input.plannedFinishMinute;
  if (!Number.isInteger(start) || !Number.isInteger(finish) || start < 0 || finish > 1440 || finish <= start) {
    throw planningError(400, "MBT_BIN_LOAD_TIME_REQUIRED", "Choose a valid start and finish time within the plan day.");
  }
}
/** @param {any} old */
function assertEditableLoad(old) {
  if (old && !old.load.mbtPlanning && (old.truck.truckType !== "bin" || old.load.stops?.length)) {
    throw planningError(409, "MBT_BIN_LOAD_REQUIRED", "Ordinary Dispatch loads are read-only here.");
  }
}
/** @param {any} input @param {any} fleet @param {any} load */
function loadFields(input, fleet, load) {
  const start = input.plannedStartMinute; const finish = input.plannedFinishMinute;
  return { mbtPlanning: true, name: String(input.name || load.name || "BIN load").slice(0, 100),
    driverId: fleet.driver.id, driverLogin: fleet.driver.login, driverName: fleet.driver.name,
    truckId: fleet.truck.id, truckPlate: String(fleet.truck.plate).toUpperCase(), switchYard: fleet.truck.base,
    plannedStartMinute: start, plannedFinishMinute: finish, startMode: "fixed",
    startTime: `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`,
    timing: { start, finish }, driverSequence: Number(load.driverSequence || 0) };
}

/** @param {any} input */
async function sequenceVisit(input) {
  const visit = await lockPlanningVisit(input.visitId, input.expectedVisitRevision);
  assertAssignedHere(visit, input);
  const previous = await readPlanningPlan(input.planId); const next = structuredClone(previous);
  const { load } = planningLoad(next, String(visit.dispatch_load_id));
  load.stops = sequenceBinVisit(load.stops, input.visitId, input.beforeVisitId ? { beforeVisitId: input.beforeVisitId } : input.direction);
  const saved = await persistPlanningPlan(previous, next);
  for (const group of binVisitGroups(load.stops)) {
    const member = await lockPlanningVisit(group.visitId);
    const staged = await stagePlanningAssignment(group.visitId, saved, input);
    await planningHistory({ ...member, revision: staged.visitRevision }, input, "sequenced", member.dispatch_assignment_snapshot,
      (await lockPlanningVisit(group.visitId)).dispatch_assignment_snapshot, saved.revision);
  }
  return { visitId: input.visitId };
}

/** @param {any} input @param {any} boundary */
async function applyPlanningAction(input, boundary) {
  /** @type {Map<string, () => Promise<any>>} */
  const actions = new Map(/** @type {Array<[string, () => Promise<any>]>} */ ([
    ["save_board", () => saveBinPlanningBoard(input, boundary, { cancelVisit, assignVisit, saveLoad })],
    ["assign", () => assignVisit(input, boundary)], ["cancel", () => cancelVisit(input)],
    ["save_load", () => saveLoad(input)], ["sequence", () => sequenceVisit(input)]
  ]));
  const action = actions.get(input.action);
  if (action) {return action();}
  if (input.action === "move" || input.action === "recover") {
    const cancelled = await cancelVisit(input);
    return assignVisit({ ...input, loadId: planningText(input.toLoadId, "Destination load"),
      assetAssignments: [], expectedVisitRevision: cancelled.visitRevision,
      idempotencyKey: `${input.idempotencyKey}:reassign` }, boundary);
  }
  const plan = await readPlanningPlan(input.planId);
  if (input.action === "confirm") {
    assertPlanningSchedule(plan, true);
    if (binDispatchOrders(plan).length) {await confirmMbtBinDispatchPlan(input, boundary);}
    else {
      await confirmDispatchPlan(input.planId, { note: input.note || "" });
      await publishPlanningAssignments(input.planId, input.actor.operatorId, plan.revision);
    }
    return {};
  }
  if (input.action === "delete_load") {
    return deleteLoad(plan, input);
  }
  if (input.action === "advance") {
    return advanceVisit(plan, input);
  }
  throw planningError(400, "MBT_BIN_COMMAND_INVALID", "This BIN planning command is not supported.");
}

/** @param {any} plan @param {any} input */
async function advanceVisit(plan, input) {
  const visit = await lockPlanningVisit(input.completedVisitId, input.expectedCompletedVisitRevision);
  if (visit.status !== "completed" || String(visit.dispatch_plan_id) !== input.planId) {
    throw planningError(409, "MBT_BIN_LEG_ADVANCEMENT_CONFLICT", "The predecessor visit has not completed on this plan.");
  }
  const visits = await releaseMbtBinSuccessorToPool(input.completedVisitId, input.actor.operatorId);
  await persistPlanningPlan(plan, plan); return { availableVisitIds: visits };
}

/** @param {any} plan @param {any} input */
async function deleteLoad(plan, input) {
  const next = structuredClone(plan); const { truck, load } = planningLoad(next, input.loadId);
  if (!load.mbtPlanning || load.stops?.length) {throw planningError(409, "MBT_BIN_LOAD_NOT_EMPTY", "Only an empty BIN load can be deleted.");}
  truck.loads = truck.loads.filter((/** @type {any} */ l) => l.id !== load.id);
  await persistPlanningPlan(plan, next); return { loadId: load.id };
}

/** @param {any} input */
function assertCommandIdentity(input) {
  if (!input.editLease || input.editLease.operatorId !== input.actor.operatorId
      || input.editLease.planDate !== input.planDate || !input.editLease.token || !input.editLease.sessionId) {
    throw planningError(409, "DISPATCH_PLAN_EDIT_LEASE_REQUIRED", "Enter Edit Mode for this date before changing the plan.");
  }
  assertVisitRevision(input);
}
/** @param {any} input */
function assertVisitRevision(input) {
  if (["assign", "cancel", "move", "recover", "sequence"].includes(input.action)
      && (!input.visitId || !Number.isSafeInteger(input.expectedVisitRevision) || input.expectedVisitRevision < 1)) {
    throw planningError(400, "MBT_BIN_DISPATCH_INPUT_INVALID", "A visit and its current revision are required.");
  }
}

/** All assignment writes, including legacy endpoints, enter this shared fence.
 * @param {any} raw @param {any} boundary */
export async function runMbtBinPlanningCommand(raw, boundary) {
  assertPlanningAccess(raw, boundary, true);
  const input = { ...raw, planId: planningText(raw.planId, "Plan"), planDate: planningDate(raw.planDate),
    reason: planningText(raw.reason, "Reason"), idempotencyKey: planningText(raw.idempotencyKey, "Idempotency key") };
  assertCommandIdentity(input);
  const { editLease, correlationId, requestId, ...request } = input;
  request.commandId = `mbt-planning:${input.actor.operatorId}:${input.idempotencyKey}`;
  try {
    const result = await withDispatchPlanWrite({ planId: input.planId, editLease,
      operation: `mbt.${input.action}`, request }, async (/** @type {any} */ previous) => {
      const body = await applyPlanningAction(input, boundary);
      const plan = await readPlanningPlan(input.planId);
      if (input.action !== "cancel" && input.action !== "advance") {
        assertPlanningSchedule(plan);
        await assertPlanningCapacity(plan);
      }
      await syncPlanningProjections(plan);
      await insertMbtAuditEvent({ actor: input.actor, correlationId, requestId, idempotencyKey: input.idempotencyKey,
        audit: { action: `mbt.bin_planning.${input.action}`, entityType: "dispatch_plan", entityId: input.planId,
          beforeState: { revision: previous.revision, digest: previous.digest },
          afterState: { revision: plan.revision, digest: plan.digest, ...body }, reason: input.reason,
          revisionBefore: previous.revision, revisionAfter: plan.revision, source: "mbt-bin-planning" } });
      if (boundary.hooks?.beforeCommit) {await boundary.hooks.beforeCommit();}
      if (boundary.onCommitted) {afterTransactionCommit(() => boundary.onCommitted({ planId: plan.id, planDate: plan.planDate, revision: plan.revision, sourceSessionId: editLease.sessionId }));}
      return { status: input.action === "assign" ? 201 : 200, body: { ...body, plan }, plan, replayed: false };
    });
    // First execution and durable JSON replay have exactly the same wire shape.
    return JSON.parse(JSON.stringify({ ...result, replayed: result.idempotentReplay === true || result.replayed === true }));
  } catch (error) {
    if (error instanceof MbtError) {throw error;}
    const e = /** @type {any} */ (error);
    if (e.status && e.code) {throw planningError(e.status, e.code, e.message, { ...(e.details || {}), lease: e.lease || null });}
    throw error;
  }
}
