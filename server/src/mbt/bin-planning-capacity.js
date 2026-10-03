// @ts-check
import { query } from "../db.js";
import { assertBinRouteCapacity } from "./bin-planning-domain.js";
import { dispatchLoadAssignment } from "../dispatch-load-assignment.js";
import { planningError } from "./bin-planning-repository.js";

/** @param {any} plan */
export async function assertPlanningCapacity(plan) {
  const trucks = plan.trucks.filter((/** @type {any} */ truck) => (truck.loads || []).some((/** @type {any} */ load) =>
    (load.stops || []).some((/** @type {any} */ stop) => stop.mbt?.visitId)));
  const visits = [...new Set(trucks.flatMap((/** @type {any} */ t) => t.loads || [])
    .flatMap((/** @type {any} */ l) => l.stops || []).map((/** @type {any} */ s) => s.mbt?.visitId).filter(Boolean))];
  if (!visits.length) {return true;}
  const steps = await query(`SELECT v.service_visit_id::text,v.actual_started_at,v.planned_truck_id::text,
      v.service_action,s.action_code,s.status,a.bin_type_id=v.bin_type_id AS type_matches,COALESCE(s.expected_asset_id,v.expected_asset_id,v.outgoing_asset_id)::text AS expected_asset_id,a.tare_weight_kg,b.maximum_payload_kg,
      st.location_kind,st.truck_id::text,st.lifecycle_status,a.active,a.under_maintenance,
      st.customer_site_profile_id::text,v.customer_site_profile_id::text AS visit_site_id
    FROM mbt_service_visits v JOIN mbt_visit_steps s ON s.service_visit_id=v.service_visit_id
    LEFT JOIN mbt_bin_assets a ON a.asset_id=COALESCE(s.expected_asset_id,v.expected_asset_id,v.outgoing_asset_id)
    LEFT JOIN mbt_bin_types b ON b.bin_type_id=a.bin_type_id
    LEFT JOIN mbt_bin_asset_state st ON st.asset_id=a.asset_id
    WHERE v.service_visit_id=ANY($1::uuid[]) ORDER BY v.service_visit_id,s.sequence_number`, [visits]);
  const byAction = new Map(steps.rows.map((/** @type {any} */ s) => [`${s.service_visit_id}:${s.action_code}`, s]));
  const capacities = await query("SELECT id::text,bin_slot_capacity,capacity_lbs FROM dispatch_trucks WHERE id=ANY($1::bigint[])", [trucks.map((/** @type {any} */ t) => t.id)]);
  const byTruck = new Map(capacities.rows.map((/** @type {any} */ t) => [String(t.id), t]));
  return assertBinRouteCapacity(trucks.map((/** @type {any} */ truck) =>
    routeForTruck(truck, byTruck.get(String(truck.id)), byAction)).filter((/** @type {any} */ route) => route.movements.length));
}

/** @param {any} truck @param {any} capacity @param {Map<string, any>} byAction */
function routeForTruck(truck, capacity, byAction) {
  /** @type {any[]} */
  const movements = [];
  const initial = new Map();
  const loads = [...(truck.loads || [])].sort((a, b) =>
    Number(dispatchLoadAssignment(truck, a).plannedStartMinute) - Number(dispatchLoadAssignment(truck, b).plannedStartMinute));
  for (const stop of loads.flatMap(load => load.stops || [])) {
    if (!stop.mbt?.visitId) {continue;}
    appendStepMovement(stop, String(truck.id), byAction.get(`${stop.mbt.visitId}:${stop.actionCode}`), initial, movements);
  }
  return { truckId: String(truck.id), slotCapacity: Number(capacity?.bin_slot_capacity || 0),
    capacityLbs: Number(capacity?.capacity_lbs || 0), initial: [...initial.values()], movements };
}

/** @param {any} stop @param {string} truckId @param {any} step @param {Map<string, any>} initial @param {any[]} movements */
function appendStepMovement(stop, truckId, step, initial, movements) {
  if (step && ["completed", "skipped"].includes(step.status)) {return;}
  if (!step || !step.active || step.under_maintenance || !step.type_matches) {
    throw planningError(409, "MBT_BIN_ASSET_UNAVAILABLE", "A planned BIN asset or visit step is unavailable.");
  }
  const assetId = step.expected_asset_id;
  const tare = Number(step.tare_weight_kg || 0) * 2.2046226218;
  const loaded = tare + Number(step.maximum_payload_kg || 0) * 2.2046226218;
  recordInitialCustody(step, truckId, initial, tare, loaded);
  const delta = actionDelta(stop.actionCode);
  const empty = ["collect_empty_bin", "load_bin", "dump_bin", "dump_load"].includes(stop.actionCode);
  movements.push({ assetId, delta, weightLbs: empty ? tare : loaded });
}

/** @param {any} step @param {string} truckId @param {Map<string, any>} initial @param {number} tare @param {number} loaded */
function recordInitialCustody(step, truckId, initial, tare, loaded) {
  if (!step.actual_started_at || !["truck", "dump_site"].includes(step.location_kind)) {return;}
  if (step.location_kind === "truck" && step.truck_id !== truckId) {
    throw planningError(409, "MBT_BIN_CUSTODY_CONFLICT", "The bin is aboard another truck.");
  }
  const empty = step.location_kind === "dump_site" || step.service_action === "delivery";
  initial.set(step.expected_asset_id, { assetId: step.expected_asset_id, weightLbs: empty ? tare : loaded });
}

/** @param {string} action */
function actionDelta(action) {
  if (["collect_empty_bin", "load_bin", "pickup_bin", "pickup_loaded_bin"].includes(action)) {return 1;}
  if (["deliver_bin", "place_bin", "return_bin", "return_empty_bin", "unload_bin"].includes(action)) {return -1;}
  // The emptied bin still occupies a slot while travelling from the dump.
  if (["dump_bin", "dump_load"].includes(action)) {return 0;}
  throw planningError(409, "MBT_BIN_ROUTE_INVALID", "This BIN action does not have a supported physical route.");
}
