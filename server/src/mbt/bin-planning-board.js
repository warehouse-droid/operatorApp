// @ts-check
import { binVisitGroups } from "./bin-planning-domain.js";
import { planningError, readPlanningPlan, lockPlanningVisit, persistPlanningPlan, samePlanningValue } from "./bin-planning-repository.js";
import { binBoardTravelFields, validateBinBoardStopTimings, validateBinBoardLaneOrder, saveBinBoardLaneOrder } from "./bin-planning-metadata.js";

/** @param {any} value */
const uuid = value => typeof value === "string" && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value);
/** @param {any} value */
const fleetId = value => /^[1-9]\d{0,17}$/.test(String(value));

/** Board writes carry intent, never replacement Dispatch snapshots or BIN steps.
 * @param {any} load */
export function binBoardLoadFields(load) {
  return { name: String(load.name || "Load").slice(0, 100),
    startMode: load.startMode === "auto" ? "auto" : "fixed", start: load.startMode === "auto" ? "" : String(load.start || load.startTime || ""),
    driverSequence: Number(load.driverSequence || 0), switchYard: String(load.switchYard || "12441"),
    parkingSpot: String(load.parkingSpot || "").slice(0, 200), allowTolls: Boolean(load.allowTolls),
    returnOnly: Boolean(load.returnOnly), manual: Boolean(load.manual), endingTrip: Boolean(load.endingTrip),
    returnYard: String(load.returnYard || "12441"),
    plannedStartMinute: load.plannedStartMinute, plannedFinishMinute: load.plannedFinishMinute ?? null,
    ...binBoardTravelFields(load) };
}

/** @param {any} load */
function currentVisits(load) {
  return binVisitGroups(load.stops || []).map(group => ({ visitId: group.visitId,
    stopTimings: group.stops.filter((/** @type {any} */ s) => s.timing).map((/** @type {any} */ s) => ({ sequence: Number(s.mbt.stopSequence), ...s.timing })),
    stopOverrides: group.stops.filter((/** @type {any} */ s) => s.stopTimeOverrideMinutes !== null && s.stopTimeOverrideMinutes !== undefined)
      .map((/** @type {any} */ s) => ({ sequence: Number(s.mbt.stopSequence), minutes: s.stopTimeOverrideMinutes })) }));
}

/** @param {any} load */
function validateLoadShape(load) {
  if (!load || !/^[\w-]{1,150}$/.test(load.id) || !Array.isArray(load.visits) || load.visits.length > 500
      || !fleetId(load.truckId) || !fleetId(load.driverId)) {
    throw planningError(400, "MBT_BIN_BOARD_INVALID", "A valid load ID and visits are required.");
  }
  binBoardTravelFields(load);
  validateLoadTimingMode(load);
}
/** @param {any} load */
function validateLoadTimingMode(load) {
  if (!Number.isInteger(load.driverSequence) || load.driverSequence < 0 || !["fixed", "auto"].includes(load.startMode)
      || (load.startMode === "fixed" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(load.start))
      || (load.returnOnly && load.visits.length)) {
    throw planningError(400, "MBT_BIN_BOARD_INVALID", "Invalid BIN load timing or sequence.");
  }
}
/** @param {any[]} overrides */
function validateOverrides(overrides) {
  if (!Array.isArray(overrides) || overrides.length > 100) {throw planningError(400, "MBT_BIN_BOARD_INVALID", "Invalid stop time overrides.");}
  const steps = new Set();
  for (const override of overrides) {
    if (!override || !Number.isInteger(override.sequence) || override.sequence < 1 || steps.has(override.sequence)
        || !Number.isInteger(override.minutes) || override.minutes < 0 || override.minutes > 1440) {
      throw planningError(400, "MBT_BIN_BOARD_INVALID", "Stop overrides must be unique whole minutes between 0 and 1440.");
    }
    steps.add(override.sequence);
  }
}
/** @param {any[]} visits @param {Set<string>} seen */
function validateVisits(visits, seen) {
  for (const visit of visits) {
    if (!uuid(visit?.visitId) || seen.has(visit.visitId) || !Number.isSafeInteger(visit.expectedVisitRevision) || visit.expectedVisitRevision < 1) {
      throw planningError(400, "MBT_BIN_BOARD_INVALID", "Each BIN visit must appear once with its current revision.");
    }
    seen.add(visit.visitId); validateOverrides(visit.stopOverrides);
    validateBinBoardStopTimings(visit.stopTimings);
  }
}
/** @param {any} plan @param {any[]} loads */
export function validateBinBoard(plan, loads) {
  if (!Array.isArray(loads) || loads.length > 500) {throw planningError(400, "MBT_BIN_BOARD_INVALID", "A BIN board must contain at most 500 loads.");}
  /** @type {Map<string, any>} */
  const existing = new Map(plan.trucks.flatMap((/** @type {any} */ t) => (t.loads || []).map((/** @type {any} */ l) => [String(l.id), { truck: t, load: l }])));
  const ids = new Set(); const visits = new Set();
  const startYards = new Map();
  for (const load of loads) {
    validateLoadShape(load);
    if (startYards.has(String(load.truckId)) && startYards.get(String(load.truckId)) !== load.truckStartYard) {
      throw planningError(400, "MBT_BIN_BOARD_INVALID", "Each BIN truck must have one starting yard for the date.");
    }
    startYards.set(String(load.truckId), load.truckStartYard);
    if (ids.has(load.id)) {throw planningError(400, "MBT_BIN_BOARD_INVALID", "Load IDs must be unique.");}
    ids.add(load.id);
    const prior = existing.get(load.id);
    if (prior && !isBinBoardLoad(prior.truck, prior.load)) {throw planningError(409, "MBT_BIN_LOAD_REQUIRED", "Ordinary Dispatch loads are read-only here.");}
    validateVisits(load.visits, visits);
  }
  return existing;
}

/** Legacy empty BIN loads are adopted on their first BIN board save.
 * @param {any} truck @param {any} load */
export function isBinBoardLoad(truck, load) {
  return Boolean(load.mbtPlanning || load.stops?.some((/** @type {any} */ s) => s.mbt?.visitId)
    || (truck.truckType === "bin" && !load.stops?.length && !load.returnOnly));
}

/** @param {any} prior @param {any} desired */
function sameLoad(prior, desired) {
  if (!prior) {return false;}
  return String(prior.load.truckId || prior.truck.id) === String(desired.truckId)
    && String(prior.load.driverId || prior.truck.driverId || "") === String(desired.driverId)
    && samePlanningValue(binBoardLoadFields(prior.load), binBoardLoadFields(desired))
    && samePlanningValue(currentVisits(prior.load), desired.visits.map((/** @type {any} */ v) => ({ visitId: v.visitId, stopTimings: v.stopTimings || [], stopOverrides: v.stopOverrides })));
}

/** @param {any} input @param {any} commands @param {Map<string, any>} existing @param {Map<string, any>} desired @param {Set<string>} changed */
async function withdrawChangedLoads(input, commands, existing, desired, changed) {
  const withdrawn = new Map();
  for (const [id, prior] of existing) {
    if (!isBinBoardLoad(prior.truck, prior.load) || (desired.has(id) && !changed.has(id))) {continue;}
    for (const group of binVisitGroups(prior.load.stops || [])) {
      const result = await commands.cancelVisit({ ...input, visitId: group.visitId, expectedVisitRevision: undefined,
        idempotencyKey: `${input.idempotencyKey}:withdraw` });
      withdrawn.set(group.visitId, result.visitRevision);
    }
    if (!desired.has(id)) {await removeEmptyBoardLoad(input.planId, id);}
  }
  return withdrawn;
}
/** @param {string} planId @param {string} id */
async function removeEmptyBoardLoad(planId, id) {
  const plan = await readPlanningPlan(planId); const next = structuredClone(plan);
  for (const truck of next.trucks) {truck.loads = (truck.loads || []).filter((/** @type {any} */ l) => l.id !== id);}
  await persistPlanningPlan(plan, next);
}
/** @param {any} input @param {any} boundary @param {any} commands @param {Map<string, any>} existing @param {Set<string>} changed @param {Map<string, number>} withdrawn */
async function assignBoardLoads(input, boundary, commands, existing, changed, withdrawn) {
  for (const load of input.loads) {
    if (!changed.has(load.id)) {continue;}
    await commands.saveLoad({ ...input, ...binBoardLoadFields(load), truckId: load.truckId, driverId: load.driverId,
      loadId: existing.has(load.id) ? load.id : "", idempotencyKey: `${input.idempotencyKey}:load:${load.id}` },
    { board: true, newLoadId: load.id, empty: !load.visits.length && !load.returnOnly });
    for (const visit of load.visits) {
      await commands.assignVisit({ ...input, ...visit, loadId: load.id,
        expectedVisitRevision: withdrawn.get(visit.visitId) ?? visit.expectedVisitRevision,
        assetAssignments: withdrawn.has(visit.visitId) ? [] : visit.assetAssignments,
        idempotencyKey: `${input.idempotencyKey}:assign:${visit.visitId}` }, boundary, visit.stopOverrides, visit.stopTimings);
    }
  }
}

/** Runs inside the shared fleet/date fence and transaction. Helpers operate on
 * authoritative visits, reservations and generations; a failure rolls back all.
 * @param {any} input @param {any} boundary @param {any} commands */
export async function saveBinPlanningBoard(input, boundary, commands) {
  const before = await readPlanningPlan(input.planId);
  validateBinBoardLaneOrder(input.driverLaneOrder);
  const existing = validateBinBoard(before, input.loads);
  /** @type {Map<string, any>} */
  const desired = new Map(input.loads.map((/** @type {any} */ l) => [l.id, l]));
  const desiredVisits = input.loads.flatMap((/** @type {any} */ l) => l.visits)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.visitId.localeCompare(b.visitId));
  for (const visit of desiredVisits) {await lockPlanningVisit(visit.visitId, visit.expectedVisitRevision);}
  /** @type {Set<string>} */
  const changed = new Set(input.loads.filter((/** @type {any} */ l) => !sameLoad(existing.get(l.id), l)).map((/** @type {any} */ l) => l.id));
  const withdrawn = await withdrawChangedLoads(input, commands, existing, desired, changed);
  await assignBoardLoads(input, boundary, commands, existing, changed, withdrawn);
  await saveBinBoardLaneOrder(before, input.driverLaneOrder);
  /** @type {Record<string, number>} */
  const visitRevisions = {};
  for (const id of new Set([...withdrawn.keys(), ...desiredVisits.map((/** @type {any} */ v) => v.visitId)])) {
    visitRevisions[id] = Number((await lockPlanningVisit(id)).revision);
  }
  return { changedLoadIds: [...changed], visitRevisions };
}
