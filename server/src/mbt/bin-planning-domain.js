// @ts-check

import { dispatchLoadAssignment } from "../dispatch-load-assignment.js";
import { canonicalJson } from "./canonical-json.js";
import { isBinDispatchOrder, binDispatchOrders } from "./dispatch-bin-safety.js";
import { MbtError } from "./errors.js";

/** @param {string} code @param {string} message @param {any} [details] */
function conflict(code, message, details = {}) {
  return new MbtError({ status: 409, code, message, details });
}

/** @param {any} plan */
function protectedBins(plan) {
  const loads = (plan?.trucks || []).flatMap((/** @type {any} */ truck) =>
    (truck.loads || []).filter((/** @type {any} */ load) => load.mbtPlanning === true
      || binDispatchOrders({ trucks: [{ loads: [load] }] }).length > 0)
      .map((/** @type {any} */ load) => ({
        id: String(load.id), truckId: String(truck.id),
        assignment: protectedAssignment(truck, load),
        driverId: String(load.driverId || truck.driverId || ""),
        startMode: load.startMode || "", startTime: load.startTime || "",
        mbtPlanning: load.mbtPlanning === true,
        returnTrip: load.returnOnly ? { yard: String(load.returnYard || "12441"), released: load.mbtReturnReleased === true } : null,
        stops: (load.stops || []).map((/** @type {any} */ stop) => {
          const { timing: _timing, loadId: _loadId, ...identity } = stop;
          return identity;
        })
      }))).sort((/** @type {any} */ a, /** @type {any} */ b) => a.id.localeCompare(b.id));
  const orders = binDispatchOrders({ orders: plan?.orders || [] });
  return { orders, loads };
}

/** Driver names are display metadata; IDs and login remain protected.
 * @param {any} truck @param {any} load */
function protectedAssignment(truck, load) {
  const { driverName: _driverName, ...assignment } = dispatchLoadAssignment(truck, load);
  return assignment;
}

/** @param {any} previous @param {any} next */
export function assertOrdinaryDispatchPreservesBins(previous, next) {
  if (canonicalJson(protectedBins(previous)) !== canonicalJson(protectedBins(next))) {
    throw conflict("MBT_BIN_PLANNING_REQUIRED", "Change BIN assignments in MBT Planning.");
  }
  return true;
}

/** Ignore only Dispatch's derived per-stop display timing, then restore the
 * exact authoritative stops so later confirmation sees the original snapshot.
 * @param {any} previous @param {any} next */
export function preserveOrdinaryDispatchBins(previous, next) {
  assertOrdinaryDispatchPreservesBins(previous, next);
  const protectedLoads = new Map((previous.trucks || []).flatMap((/** @type {any} */ t) => t.loads || [])
    .filter((/** @type {any} */ l) => l.mbtPlanning || (l.stops || []).some(isBinDispatchOrder))
    .map((/** @type {any} */ l) => [String(l.id), l]));
  return { ...next, trucks: (next.trucks || []).map((/** @type {any} */ truck) => ({ ...truck,
    loads: (truck.loads || []).map((/** @type {any} */ load) => protectedLoads.has(String(load.id))
      ? { ...load, stops: structuredClone(protectedLoads.get(String(load.id)).stops || []) } : load)
  })) };
}

/** @param {any[]} stops */
export function binVisitGroups(stops) {
  /** @type {Array<{visitId: string, stops: any[]}>} */
  const groups = [];
  const seen = new Set();
  for (const stop of stops) {
    const visitId = String(stop?.mbt?.visitId || "");
    if (!visitId || !isBinDispatchOrder(stop)) {
      throw conflict("MBT_BIN_LOAD_REQUIRED", "This operation requires a BIN-only load.");
    }
    const previous = groups.at(-1);
    if (previous?.visitId === visitId) {previous.stops.push(stop); continue;}
    if (seen.has(visitId)) {
      throw conflict("MBT_BIN_LEG_SPLIT_FORBIDDEN", "Every stop must remain in its whole BIN visit.");
    }
    seen.add(visitId);
    groups.push({ visitId, stops: [stop] });
  }
  return groups;
}

/** @param {any[]} stops @param {string} visitId @param {number | {beforeVisitId: string}} direction */
export function sequenceBinVisit(stops, visitId, direction) {
  if (typeof direction !== "object" && direction !== -1 && direction !== 1) {
    throw conflict("MBT_BIN_SEQUENCE_INVALID", "Choose the previous or next visit position.");
  }
  const groups = binVisitGroups(stops);
  const index = groups.findIndex(group => group.visitId === visitId);
  if (index < 0) {throw conflict("MBT_BIN_VISIT_NOT_ASSIGNED", "The BIN visit is no longer in this load.");}
  const moving = groups[index];
  if (!moving) {throw conflict("MBT_BIN_VISIT_NOT_ASSIGNED", "The BIN visit is no longer in this load.");}
  if (typeof direction === "object") {
    const target = groups.findIndex(group => group.visitId === direction.beforeVisitId);
    if (target < 0) {throw conflict("MBT_BIN_VISIT_NOT_ASSIGNED", "The destination visit is no longer in this load.");}
    groups.splice(index, 1);
    groups.splice(target > index ? target - 1 : target, 0, moving);
  } else {
    const target = index + direction;
    const other = groups[target];
    if (other) {groups[index] = other; groups[target] = moving;}
  }
  return groups.flatMap(group => group.stops);
}

/** @param {any[]} routes */
export function assertBinRouteCapacity(routes) {
  for (const route of routes) {
    const aboard = new Map();
    for (const movement of [...(route.initial || []).map((/** @type {any} */ item) => ({ ...item, delta: 1 })), ...route.movements]) {
      applyMovement(aboard, movement);
      const weightLbs = [...aboard.values()].reduce((sum, weight) => sum + weight, 0);
      if (aboard.size > route.slotCapacity || weightLbs > route.capacityLbs) {
        throw conflict("MBT_BIN_CAPACITY_EXCEEDED", "The BIN route exceeds the truck's capacity.", {
          truckId: route.truckId, requiredSlots: aboard.size, weightLbs
        });
      }
    }
  }
  return true;
}

/** @param {Map<string, number>} aboard @param {any} movement */
function applyMovement(aboard, movement) {
  if (movement.delta === -1) {
    if (!aboard.delete(movement.assetId)) {
      throw conflict("MBT_BIN_ROUTE_INVALID", "A BIN must be aboard before it can be unloaded.");
    }
    return;
  }
  const expectedPresence = movement.delta === 0;
  if (![0, 1].includes(movement.delta) || aboard.has(movement.assetId) !== expectedPresence
      || !Number.isFinite(movement.weightLbs) || movement.weightLbs < 0) {
    throw conflict("MBT_BIN_ROUTE_INVALID", "The BIN route has inconsistent physical movements.");
  }
  aboard.set(movement.assetId, movement.weightLbs);
}
