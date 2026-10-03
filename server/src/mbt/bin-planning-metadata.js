// @ts-check
import { query } from "../db.js";
import { planningError } from "./bin-planning-repository.js";

/** @param {string} message */
function invalid(message) {throw planningError(400, "MBT_BIN_BOARD_INVALID", message);}
/** @param {any} value @param {number} [limit] */
function minute(value, limit = 1440) {return Number.isInteger(value) && value >= 0 && value <= limit;}
/** @param {any} value @param {number} limit */
function shortText(value, limit) {return typeof value === "string" && value.length <= limit;}
/** @param {any} value @param {number} limit */
function coordinates(value, limit) {
  if (!Array.isArray(value) || value.length > limit) {invalid("Invalid route geometry.");}
  return value.map((/** @type {any} */ point) => {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
      invalid("Invalid route coordinates.");
    }
    return { lat: point.lat, lng: point.lng };
  });
}
/** @param {any} value */
function routeMinutes(value) {
  if (!Array.isArray(value) || value.length > 200 || !value.every(n => minute(n))) {invalid("Invalid route travel minutes.");}
  return [...value];
}
/** Dispatch estimates are derived metadata, never executable route steps.
 * @param {any} value */
export function binBoardRouteEstimate(value) {
  if (value === undefined || value === null) {return null;}
  if (value.source !== "google" || !shortText(value.routeSignature, 16000) || !shortText(value.routeEstimateId, 100)
      || !Number.isFinite(value.travelTimePercent) || Math.abs(value.travelTimePercent) > 1000) {invalid("Invalid saved route estimate.");}
  const totals = [value.rawDriveMinutes, value.driveMinutes, value.stayMinutes, value.totalMinutes];
  if (!totals.every(n => Number.isFinite(n) && n >= 0 && n <= 1440)) {invalid("Invalid route duration.");}
  return { source: "google", routeSignature: value.routeSignature, routeEstimateId: value.routeEstimateId,
    rawDriveMinutes: value.rawDriveMinutes, driveMinutes: value.driveMinutes, stayMinutes: value.stayMinutes, totalMinutes: value.totalMinutes,
    legMinutes: routeMinutes(value.legMinutes), rawLegMinutes: routeMinutes(value.rawLegMinutes),
    allowTolls: Boolean(value.allowTolls), travelTimePercent: value.travelTimePercent,
    routePath: coordinates(value.routePath, 5000), stopCoordinates: coordinates(value.stopCoordinates, 25) };
}
/** @param {any} load */
export function binBoardTravelFields(load) {
  const minutes = load.handoffTravelMinutes ?? 0;
  const from = load.handoffTravelFrom ?? ""; const to = load.handoffTravelTo ?? "";
  if (!minute(minutes) || !shortText(from, 2000) || !shortText(to, 2000)) {invalid("Invalid truck-switch approach.");}
  const truckStartYard = load.truckStartYard ?? null;
  if (truckStartYard !== null && !shortText(truckStartYard, 100)) {invalid("Invalid truck starting yard.");}
  return { handoffTravelMinutes: minutes, handoffTravelFrom: from, handoffTravelTo: to, routeEstimate: binBoardRouteEstimate(load.routeEstimate), truckStartYard };
}
/** @param {any} timings */
export function validateBinBoardStopTimings(timings = []) {
  if (!Array.isArray(timings) || timings.length > 100) {invalid("Invalid stop timings.");}
  const seen = new Set();
  for (const row of timings) {
    if (!row || !minute(row.sequence, 100) || row.sequence < 1 || seen.has(row.sequence)
        || !minute(row.arrival) || !minute(row.depart) || row.depart < row.arrival) {invalid("Invalid stop arrival or departure.");}
    seen.add(row.sequence);
  }
}
/** @param {any} order */
export function validateBinBoardLaneOrder(order) {
  if (order === undefined) {return;}
  if (!Array.isArray(order) || order.length > 1000 || order.some(id => !shortText(id, 200) || !id.length)
      || new Set(order).size !== order.length) {invalid("Invalid driver lane order.");}
}
/** Preserve all other shared summary fields. Called only inside the plan fence.
 * @param {any} plan @param {any} order */
export async function saveBinBoardLaneOrder(plan, order) {
  if (order === undefined || JSON.stringify(order) === JSON.stringify(plan.summary?.driverLaneOrder)) {return;}
  await query("UPDATE dispatch_plan_snapshots SET summary=jsonb_set(COALESCE(summary,'{}'::jsonb),'{driverLaneOrder}',$2::jsonb),saved_at=now() WHERE plan_id=$1",
    [plan.id, JSON.stringify(order)]);
  await query("UPDATE dispatch_plans SET revision=revision+1,updated_at=now() WHERE id=$1", [plan.id]);
}
