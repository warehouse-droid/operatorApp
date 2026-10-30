// @ts-check
import { query } from "../db.js";
import { assertBinRouteCapacity } from "./bin-planning-domain.js";
import { dispatchLoadAssignment } from "../dispatch-load-assignment.js";
import { planningError } from "./bin-planning-repository.js";
import { MbtError } from "./errors.js";

/** Advisory reads must leave invalid plans available for correction.
 * @param {any} plan */
export async function planningCapacityWarnings(plan) {
  if (!plan) {return [];}
  try {await assertPlanningCapacity(plan);}
  catch (error) {if (!(error instanceof MbtError)) {throw error;}}
  return plan.binCapacityWarnings || [];
}

/** @param {any} plan */
export async function assertPlanningCapacity(plan) {
  plan.binCapacityWarnings=[];
  const trucks = plan.trucks.filter((/** @type {any} */ truck) => (truck.loads || []).some((/** @type {any} */ load) =>
    (load.stops || []).some((/** @type {any} */ stop) => stop.mbt?.visitId)));
  const visits = [...new Set(trucks.flatMap((/** @type {any} */ t) => t.loads || [])
    .flatMap((/** @type {any} */ l) => l.stops || []).map((/** @type {any} */ s) => s.mbt?.visitId).filter(Boolean))];
  if (!visits.length) {return true;}
  const steps = await query(`SELECT v.service_visit_id::text,v.actual_started_at,v.planned_truck_id::text,
      v.service_action,v.service_snapshot AS service_snapshot,v.service_snapshot->'binWorkflow' AS bin_workflow,m.movement_type,
      (SELECT (stop->>'cargoWeightLbs')::float FROM jsonb_array_elements(v.service_snapshot->'mandatoryStops') stop
        JOIN mbt_visit_steps done ON done.service_visit_id=v.service_visit_id AND done.action_code=stop->>'actionCode'
        WHERE done.status='completed' AND stop ? 'cargoWeightLbs' ORDER BY done.sequence_number DESC LIMIT 1) AS current_cargo_weight,
      s.action_code,s.status,v.visit_reference AS reference,a.asset_code,a.bin_type_id=v.bin_type_id AS type_matches,COALESCE(s.expected_asset_id,v.expected_asset_id,v.outgoing_asset_id)::text AS expected_asset_id,a.tare_weight_kg,b.maximum_payload_kg,
      st.location_kind,st.truck_id::text,st.lifecycle_status,a.active,a.under_maintenance,
      st.customer_site_profile_id::text,v.customer_site_profile_id::text AS visit_site_id,
      (SELECT p.part_role FROM mbt_bin_workflow_dependencies d
        JOIN mbt_bin_order_parts p ON p.visit_id=d.prerequisite_visit_id
        JOIN mbt_service_visits prior ON prior.service_visit_id=p.visit_id
        JOIN dispatch_plans pp ON pp.id::text=prior.dispatch_plan_id
        JOIN dispatch_plans current_plan ON current_plan.id::text=v.dispatch_plan_id
        JOIN mbt_visit_steps ps ON ps.service_visit_id=p.visit_id AND ps.action_code=d.prerequisite_action_code
        WHERE d.dependent_visit_id=v.service_visit_id AND p.asset_id=COALESCE(s.expected_asset_id,v.expected_asset_id)
          AND ps.status<>'completed' AND pp.plan_date<current_plan.plan_date
          AND (p.part_role='delivery' OR prior.planned_truck_id=v.planned_truck_id)
        ORDER BY pp.plan_date DESC LIMIT 1) AS prior_day_role
    FROM mbt_service_visits v JOIN mbt_visit_steps s ON s.service_visit_id=v.service_visit_id
    LEFT JOIN mbt_bin_assets a ON a.asset_id=COALESCE(s.expected_asset_id,v.expected_asset_id,v.outgoing_asset_id)
    LEFT JOIN mbt_bin_types b ON b.bin_type_id=a.bin_type_id
    LEFT JOIN mbt_bin_asset_state st ON st.asset_id=a.asset_id
    LEFT JOIN mbt_bin_movements m ON m.movement_id=st.last_movement_id
    WHERE v.service_visit_id=ANY($1::uuid[]) ORDER BY v.service_visit_id,s.sequence_number`, [visits]);
  const transport=await query(`SELECT t.trip_id::text AS service_visit_id,t.actual_started_at,t.truck_id::text AS planned_truck_id,
    'transport' AS service_action,jsonb_build_object('mandatoryStops',t.route->'stops') AS service_snapshot,
    jsonb_build_object('source',t.route->'source') AS bin_workflow,m.movement_type,
    (SELECT (done.snapshot->>'cargoWeightLbs')::numeric FROM mbt_transport_steps done WHERE done.trip_id=t.trip_id
      AND done.status='completed' ORDER BY done.sequence_number DESC LIMIT 1) AS current_cargo_weight,
    step.action_code,step.status,source.source_ref AS reference,a.asset_code,true AS type_matches,a.asset_id::text AS expected_asset_id,a.tare_weight_kg,b.maximum_payload_kg,
    st.location_kind,st.truck_id::text,st.lifecycle_status,a.active,a.under_maintenance,NULL::text AS prior_day_role
    FROM mbt_transport_trips t JOIN mbt_transport_steps step USING(trip_id)
    JOIN mbt_transport_sources source USING(source_key)
    JOIN mbt_bin_assets a USING(asset_id) JOIN mbt_bin_types b USING(bin_type_id)
    JOIN mbt_bin_asset_state st USING(asset_id) JOIN mbt_bin_movements m ON m.movement_id=st.last_movement_id
    WHERE t.trip_id=ANY($1::uuid[])`,[visits]);
  steps.rows.push(...transport.rows);
  const byAction = new Map(steps.rows.map((/** @type {any} */ s) => [`${s.service_visit_id}:${s.action_code}`, s]));
  const capacities = await query("SELECT id::text,bin_slot_capacity,capacity_lbs FROM dispatch_trucks WHERE id=ANY($1::bigint[])", [trucks.map((/** @type {any} */ t) => t.id)]);
  const byTruck = new Map(capacities.rows.map((/** @type {any} */ t) => [String(t.id), t]));
  return assertBinRouteCapacity(trucks.map((/** @type {any} */ truck) =>
    routeForTruck(truck, byTruck.get(String(truck.id)), byAction)).filter((/** @type {any} */ route) => route.movements.length),plan.binCapacityWarnings);
}

/** @param {any} truck @param {any} capacity @param {Map<string, any>} byAction */
function routeForTruck(truck, capacity, byAction) {
  /** @type {any[]} */
  const movements = [];
  const initial = new Map();
  const loads = [...(truck.loads || [])].sort((a, b) =>
    Number(dispatchLoadAssignment(truck, a).plannedStartMinute) - Number(dispatchLoadAssignment(truck, b).plannedStartMinute));
  for (const load of loads) {
    for (const stop of load.stops || []) {
      if (!stop.mbt?.visitId) {continue;}
      appendStepMovement(stop, String(truck.id), byAction.get(`${stop.mbt.visitId}:${stop.actionCode}`), initial, movements,load);
    }
  }
  return { truckId: String(truck.id),truckPlate:truck.plate, slotCapacity: Number(capacity?.bin_slot_capacity || 0),
    capacityLbs: Number(capacity?.capacity_lbs || 0), initial: [...initial.values()], movements };
}

/** @param {any} stop @param {string} truckId @param {any} step @param {Map<string, any>} initial @param {any[]} movements @param {any} load */
function appendStepMovement(stop, truckId, step, initial, movements,load) {
  if (step && ["completed", "skipped"].includes(step.status)) {return;}
  if (!step || !step.active || step.under_maintenance || !step.type_matches) {
    throw planningError(409, "MBT_BIN_ASSET_UNAVAILABLE", "A planned BIN asset or visit step is unavailable.");
  }
  const assetId = step.expected_asset_id;
  const tare = Number(step.tare_weight_kg || 0) * 2.2046226218;
  const loaded = tare + Number(step.maximum_payload_kg || 0) * 2.2046226218;
  recordInitialCustody(step, truckId, initial, tare, loaded);
  const snapshot=step.service_snapshot.mandatoryStops.find((/** @type {any} */ s)=>s.actionCode===stop.actionCode);
  const labels=stepWarningContext(stop,step,load,snapshot);
  const existing=initial.get(assetId);if (existing && !existing.loadId) {Object.assign(existing,labels);}
  movements.push({...labels,assetId,...stepWeightMovement(stop,snapshot,tare,loaded)});
}

/** @param {any} stop @param {any} step @param {any} load @param {any} snapshot */
function stepWarningContext(stop,step,load,snapshot) {
  return {loadId:load.id,loadName:load.name,visitId:step.service_visit_id,actionCode:stop.actionCode,
    displayName:snapshot?.displayName || stop.displayName,reference:snapshot?.reference || step.reference,assetCode:step.asset_code};
}

/** @param {any} stop @param {any} snapshot @param {number} tare @param {number} loaded */
function stepWeightMovement(stop,snapshot,tare,loaded) {
  const delta = actionDelta(stop.actionCode);
  const empty = ["collect_empty_bin", "load_bin", "dump_bin", "dump_load"].includes(stop.actionCode);
  const cargo=snapshot?.cargoWeightLbs;
  return {delta, weightLbs: cargo!==undefined ? tare+Number(cargo) : empty ? tare : loaded,
    estimated:cargo===undefined && !empty && delta!==-1};
}

/** @param {any} step */
function custodyNotYetRequired(step) {
  if (step.prior_day_role==='delivery') {return true;}
  return !step.actual_started_at && Boolean(step.bin_workflow?.source?.availabilityPredecessorId || step.bin_workflow?.source?.transportTripId);
}
/** @param {any} step @param {string} truckId @param {Map<string, any>} initial @param {number} tare @param {number} loaded */
function recordInitialCustody(step, truckId, initial, tare, loaded) {
  if (custodyNotYetRequired(step)) {return;}
  if (step.prior_day_role==="collection") {
    initial.set(step.expected_asset_id,{assetId:step.expected_asset_id,weightLbs:tare,estimated:false});
    return;
  }
  if ((!step.actual_started_at && !step.bin_workflow) || !["truck", "dump_site"].includes(step.location_kind)) {return;}
  if (step.location_kind === "truck" && step.truck_id !== truckId) {
    throw planningError(409, "MBT_BIN_CUSTODY_CONFLICT", "The bin is aboard another truck.");
  }
  initial.set(step.expected_asset_id,initialBinWeight(step,tare,loaded));
}

/** @param {any} step @param {number} tare @param {number} loaded */
function initialBinWeight(step,tare,loaded) {
  const empty = step.location_kind === "dump_site" || step.service_action === "delivery"
    || (step.bin_workflow && /dump|empty/u.test(String(step.movement_type)));
  return { assetId: step.expected_asset_id,
    weightLbs:initialCargoWeight(step,tare,empty ? tare : loaded),estimated:step.current_cargo_weight===null && !empty };
}
/** @param {any} step @param {number} tare @param {number} fallback */
function initialCargoWeight(step,tare,fallback) {
  return step.current_cargo_weight!==null ? tare+Number(step.current_cargo_weight) : fallback;
}

/** @param {string} action */
function actionDelta(action) {
  if (/^cargo_(pickup|dropoff)_\d+$/u.test(action)) {return 0;}
  if (["collect_empty_bin", "load_bin", "pickup_bin", "pickup_loaded_bin"].includes(action)) {return 1;}
  if (["deliver_bin", "place_bin", "return_bin", "return_empty_bin", "unload_bin"].includes(action)) {return -1;}
  // The emptied bin still occupies a slot while travelling from the dump.
  if (["dump_bin", "dump_load"].includes(action)) {return 0;}
  throw planningError(409, "MBT_BIN_ROUTE_INVALID", "This BIN action does not have a supported physical route.");
}
