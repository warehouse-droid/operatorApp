// @ts-check
import crypto from 'node:crypto';
import {query} from '../db.js';
import {dispatchLoadAssignment} from '../dispatch-load-assignment.js';
import {canonicalSha256} from './canonical-json.js';
import {readPlanningPlan,planningLoad,persistPlanningPlan,removePlanningVisit} from './bin-planning-repository.js';
import {binWorkflowAsset} from './bin-order-workflow-repository.js';
import {binAvailability,availableBinSource,assertBinSourceMatches,connectedBinVisits} from './bin-availability.js';
import {validateTransportDeliveryLinks} from './bin-transport-delivery.js';
import {transportError} from './bin-transport-domain.js';
import {readTransportSource,assertTransportSourceOpen} from './bin-transport-sources.js';

/** @param {string} id @param {boolean} [lock] */
export async function transportPlanningVisit(id,lock=false) {
  const row=(await query(`SELECT t.*,s.source_ref,s.source_snapshot,s.source_fingerprint,a.asset_code,a.bin_type_id,
    b.type_code,b.maximum_payload_kg,a.tare_weight_kg FROM mbt_transport_trips t
    JOIN mbt_transport_sources s USING(source_key) JOIN mbt_bin_assets a USING(asset_id)
    JOIN mbt_bin_types b USING(bin_type_id) WHERE t.trip_id=$1 ${lock?'FOR UPDATE OF t':''}`,[id])).rows[0];
  if (!row) {return null;}
  // Typed planning adapter only; transport is never inserted into rental tables.
  return {...row,transportTripId:row.trip_id,service_visit_id:row.trip_id,visit_reference:`${row.source_ref} · Trip ${row.trip_number}`,
    dispatch_plan_id:row.plan_id?String(row.plan_id):null,dispatch_load_id:row.load_id,planned_truck_id:row.truck_id,
    planned_driver_id:row.driver_id,planning_generation:Number(row.generation),dispatch_assignment_snapshot:row.assignment_snapshot,
    expected_asset_id:row.asset_id,service_snapshot:{transport:true,mandatoryStops:row.route.stops}};
}

/** @param {any} trip @param {any} truck @param {any} load @param {string} date @param {any[]} [timings] */
async function validateTripReservation(trip,truck,load,date,timings) {
  const current=await readTransportSource(trip.source_ref);
  if (current.fingerprint!==trip.source_fingerprint) {
    throw transportError('The source order changed. Refresh its transport trips before planning.','MBT_TRANSPORT_SOURCE_CHANGED');
  }
  await assertTransportSourceOpen(current);
  const timing=dispatchLoadAssignment(truck,load);
  if (!Number.isFinite(timing.plannedStartMinute) || !Number.isFinite(timing.plannedFinishMinute)
      || Number(timing.plannedStartMinute)>=Number(timing.plannedFinishMinute) || !timing.driverLogin) {
    throw transportError('Choose a BIN load with a driver, start and finish time.');
  }
  const capability=await query(`SELECT 1 FROM dispatch_trucks t JOIN dispatch_truck_bin_types c ON c.truck_id=t.id
    JOIN dispatch_drivers d ON d.id=$3 WHERE t.id=$1 AND c.bin_type_id=$2 AND c.active AND t.active
    AND t.truck_type='bin' AND t.bin_service_enabled AND t.bin_slot_capacity>=1 AND d.active`,
    [truck.id,trip.bin_type_id,load.driverId || truck.driverId]);
  if (!capability.rowCount || Number(trip.weight_lbs)>Number(trip.maximum_payload_kg)*2.2046226218) {
    throw transportError('Choose an active BIN truck supporting this size and the cargo weight.');
  }
  const range=tripInterval(trip,load,timing,timings);
  const times=(await query(`SELECT (($1::date+$2::int*interval '1 minute') AT TIME ZONE 'America/Toronto') AS start,
    (($1::date+$3::int*interval '1 minute') AT TIME ZONE 'America/Toronto') AS finish`,
  [date,range.start,range.finish])).rows[0];
  const asset=await binWorkflowAsset(String(trip.asset_id),true);
  const available=availableBinSource(await binAvailability(asset,{at:times.start,until:times.finish,truckId:truck.id,
    exclude:await connectedBinVisits(trip.trip_id,trip.asset_id)}));
  const source=trip.route.source;
  await assertBinSourceMatches(source,available);
  return times;
}

/** @param {any} trip @param {any} load @param {any} loadTime @param {any[]} [provided] */
function tripInterval(trip,load,loadTime,provided) {
  const timings=provided || load.stops.filter((/** @type {any} */ stop)=>stop.mbt?.transportTripId===trip.trip_id)
    .map((/** @type {any} */ stop)=>stop.timing).filter(Boolean);
  if (!timings.length) {return {start:loadTime.plannedStartMinute,finish:loadTime.plannedFinishMinute};}
  if (timings.length!==trip.route.stops.length) {throw transportError('Provide times for every transport action.');}
  let prior=loadTime.plannedStartMinute;
  for (const time of timings) {
    if (!Number.isInteger(time.arrival) || !Number.isInteger(time.depart) || time.arrival<prior
        || time.depart<time.arrival || time.depart>loadTime.plannedFinishMinute) {throw transportError('Transport action times must follow the route inside the load.');}
    prior=time.depart;
  }
  return {start:timings[0].arrival,finish:timings.at(-1).depart};
}

/** @param {any} trip */
function assertUnstartedTrip(trip) {
  if (trip.actual_started_at || ['in_progress','completed','cancelled'].includes(trip.status)) {
    throw transportError('This transport trip has started. Its route and assignment are locked.');
  }
}

/** @param {any} input @param {any} trip @param {any[]} [overrides] @param {any[]} [timings] */
export async function assignTransportVisit(input,trip,overrides=[],timings=[]) {
  assertUnstartedTrip(trip);
  if (trip.plan_id) {throw transportError('This transport trip is already planned.');}
  const plan=await readPlanningPlan(input.planId),next=structuredClone(plan),{truck,load}=planningLoad(next,input.loadId);
  if (load.stops.some((/** @type {any} */ s)=>!s.mbt?.visitId)) {throw transportError('Choose a BIN-only load.');}
  await validateTripReservation(trip,truck,load,plan.planDate,timings);
  const steps=(await query('SELECT * FROM mbt_transport_steps WHERE trip_id=$1 ORDER BY sequence_number',[trip.trip_id])).rows;
  const stops=steps.map((/** @type {any} */ step)=>{
    const original=step.snapshot,override=overrides.find(o=>o.sequence===step.sequence_number),time=timings.find(t=>t.sequence===step.sequence_number);
    if (time && (time.arrival<load.plannedStartMinute || time.depart>load.plannedFinishMinute || time.depart<time.arrival)) {
      throw transportError('Transport stop times must fit inside the load.');
    }
    return {...original,id:`transport:${trip.trip_id}:${step.step_id}`,orderId:`MBT-TRIP-${trip.trip_id}`,loadId:String(load.id),
      reference:trip.visit_reference,assetId:trip.asset_id,assetCode:trip.asset_code,location:original.location.address,
      type:original.type==='pickup'?'pick':'drop',...(override?{stopTimeOverrideMinutes:override.minutes}:{}),
      ...(time?{timing:{arrival:time.arrival,depart:time.depart}}:{}),
      mbt:{workKind:'transport',transportTripId:trip.trip_id,visitId:trip.trip_id,stepId:step.step_id,
        stopSequence:step.sequence_number,stopGroupId:trip.trip_id,mandatory:true}};
  });
  load.stops.push(...stops);load.mbtPlanning=true;
  await query(`UPDATE mbt_transport_trips SET plan_id=$2,load_id=$3,truck_id=$4,driver_id=$5,status='planned',
    updated_by=$6,updated_at=now() WHERE trip_id=$1`,[trip.trip_id,plan.id,load.id,truck.id,load.driverId || truck.driverId,input.actor.operatorId]);
  const saved=await persistPlanningPlan(plan,next);
  return {visitId:trip.trip_id,...await stageTransportAssignment(trip.trip_id,saved,input)};
}

/** @param {string} id @param {any} plan @param {any} input */
export async function stageTransportAssignment(id,plan,input) {
  const trip=await transportPlanningVisit(id,true);assertUnstartedTrip(trip);
  const {truck,load}=planningLoad(plan,String(trip.load_id));
  const times=await validateTripReservation(trip,truck,load,plan.planDate);
  await withdrawTransportHistory(trip);
  const generation=Number(trip.generation)+1,revision=Number(trip.revision)+1;
  load.stops=load.stops.map((/** @type {any} */ s)=>s.mbt?.transportTripId!==id?s:{...s,
    id:`transport:${id}:${s.mbt.stepId}:mbt-g${generation}`,mbt:{...s.mbt,planningGeneration:generation,driverReleased:false}});
  const snapshot={tripId:id,sourceRef:trip.source_ref,sourceFingerprint:trip.source_fingerprint,routeHash:canonicalSha256(trip.route),
    generation,visitRevision:revision,planId:String(plan.id),planDate:plan.planDate,loadId:String(load.id),
    truckId:String(truck.id),driverId:String(load.driverId || truck.driverId),driverLogin:String(load.driverLogin || truck.driverLogin),
    stops:load.stops.filter((/** @type {any} */ s)=>s.mbt?.transportTripId===id)};
  await query(`UPDATE mbt_transport_trips SET generation=$2,revision=$3,assignment_snapshot=$4::jsonb,
    truck_id=$5,driver_id=$6,reserved_from=$7,reserved_until=$8,driver_released_at=NULL,updated_by=$9,updated_at=now() WHERE trip_id=$1`,
  [id,generation,revision,JSON.stringify(snapshot),truck.id,load.driverId || truck.driverId,times.start,times.finish,input.actor.operatorId]);
  await query(`INSERT INTO mbt_transport_assignment_history(assignment_id,trip_id,generation,plan_id,snapshot,created_by)
    VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[crypto.randomUUID(),id,generation,plan.id,JSON.stringify(snapshot),input.actor.operatorId]);
  await query('UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1',[plan.id,JSON.stringify(plan.trucks)]);
  return {visitRevision:revision,generation,stops:snapshot.stops};
}

/** @param {any} trip */
async function withdrawTransportHistory(trip) {
  await query('UPDATE mbt_transport_assignment_history SET withdrawn_at=now() WHERE trip_id=$1 AND withdrawn_at IS NULL',[trip.trip_id]);
  await query(`UPDATE driver_job_records SET mbt_assignment_withdrawn_at=COALESCE(mbt_assignment_withdrawn_at,now())
    WHERE plan_id=$1 AND load_id=$2 AND stop_id=ANY($3::text[])`,[trip.plan_id,trip.load_id,(trip.assignment_snapshot?.stops || []).map((/** @type {any} */ s)=>s.id)]);
}

/** @param {any} input @param {any} trip */
export async function unplanTransportVisit(input,trip) {
  assertUnstartedTrip(trip);
  if (String(trip.plan_id)!==String(input.planId)) {throw transportError('The transport assignment changed. Refresh the plan.');}
  const previous=await readPlanningPlan(input.planId),next=structuredClone(previous);removePlanningVisit(next,trip.trip_id);
  await withdrawTransportHistory(trip);
  await query(`UPDATE mbt_transport_trips SET plan_id=NULL,load_id=NULL,truck_id=NULL,driver_id=NULL,
    reserved_from=NULL,reserved_until=NULL,assignment_snapshot=NULL,driver_released_at=NULL,status='ready',revision=revision+1,
    updated_by=$2,updated_at=now() WHERE trip_id=$1`,[trip.trip_id,input.actor.operatorId]);
  await persistPlanningPlan(previous,next,[trip.trip_id]);
  return {visitId:trip.trip_id,visitRevision:Number(trip.revision)+1};
}

/** @param {any} plan */
function transportGroups(plan) {
  const groups=new Map();
  for (const truck of plan.trucks) {for (const load of truck.loads || []) {for (const stop of load.stops || []) {
    if (!stop.mbt?.transportTripId) {continue;}
    const id=stop.mbt.transportTripId,current=groups.get(id);
    if (current && (current.truck.id!==truck.id || current.load.id!==load.id)) {throw transportError('Keep a transport trip together in one load.');}
    const group=current || {truck,load,stops:[]};group.stops.push(stop);groups.set(id,group);
  }}}
  return groups;
}
/** @param {any} trip @param {any} group @param {any} snapshot */
function assertTransportAssignment(trip,group,snapshot) {
    if (!group || !snapshot || canonicalSha256(snapshot.stops)!==canonicalSha256(group.stops)
        || snapshot.routeHash!==canonicalSha256(trip.route) || String(group.truck.id)!==String(trip.truck_id)
        || String(group.load.id)!==String(trip.load_id) || String(group.load.driverId || group.truck.driverId)!==String(trip.driver_id)) {
      throw transportError('The transport route or assignment changed. Refresh before confirming.');
    }
}

/** @param {any} plan */
export async function validateTransportPlan(plan) {
  await validateTransportDeliveryLinks(plan);
  const trips=(await query('SELECT trip_id FROM mbt_transport_trips WHERE plan_id=$1 ORDER BY trip_id FOR UPDATE',[plan.id])).rows;
  const groups=transportGroups(plan);
  if (groups.size!==trips.length) {throw transportError('The saved transport assignments changed. Refresh the plan.');}
  for (const {trip_id:id} of trips) {
    const trip=await transportPlanningVisit(id,true),group=groups.get(id),snapshot=trip.assignment_snapshot;
    assertTransportAssignment(trip,group,snapshot);
    if (!trip.actual_started_at) {await validateTripReservation(trip,group.truck,group.load,plan.planDate);}
  }
}

/** @param {any} plan @param {string[] | null} [ids] */
export async function publishTransportAssignments(plan,ids=null) {
  const pending=(await query(`SELECT * FROM mbt_transport_trips WHERE plan_id=$1 AND driver_released_at IS NULL
    AND ($2::uuid[] IS NULL OR trip_id=ANY($2::uuid[])) FOR UPDATE`,[plan.id,ids])).rows;
  if (pending.length) {await validateTransportPlan(plan);}
  for (const trip of pending) {
    const {load}=planningLoad(plan,trip.load_id);
    for (const stop of load.stops.filter((/** @type {any} */ s)=>s.mbt?.transportTripId===trip.trip_id)) {stop.mbt.driverReleased=true;}
    const snapshot={...trip.assignment_snapshot,stops:load.stops.filter((/** @type {any} */ s)=>s.mbt?.transportTripId===trip.trip_id)};
    await query('UPDATE mbt_transport_trips SET driver_released_at=now(),assignment_snapshot=$2::jsonb WHERE trip_id=$1',[trip.trip_id,JSON.stringify(snapshot)]);
    await query('UPDATE mbt_transport_assignment_history SET released_at=now(),snapshot=$3::jsonb WHERE trip_id=$1 AND generation=$2',
      [trip.trip_id,trip.generation,JSON.stringify(snapshot)]);
  }
  return pending.length;
}
