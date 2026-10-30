// @ts-check
import { query } from "../db.js";
import { binWorkflowError } from "./bin-order-workflow-repository.js";
import { planningLoad } from "./bin-planning-repository.js";

/** @param {any} snapshot */
function sourceIdentity(snapshot) {
  const source=snapshot.binWorkflow?.source;
  if (source) {return `${source.kind}:${source.id}`;}
  const pickup=snapshot.mandatoryStops?.find((/** @type {any} */ s)=>s.actionCode==="collect_empty_bin");
  return pickup?.yardId ? `yard:${pickup.yardId}` : "";
}
/** @param {any} snapshot */
function routeIdentity(snapshot) {
  return JSON.stringify((snapshot.mandatoryStops || []).map((/** @type {any} */ s)=>[s.actionCode,s.planningAddress || s.location?.address]));
}
/** @param {any} snapshot */
function hasCargoStops(snapshot) {
  return (snapshot.mandatoryStops || []).some((/** @type {any} */ s)=>s.actionCode?.startsWith("cargo_"));
}
/** @param {any} before @param {any} after */
function routeChanged(before,after) {
  if (sourceIdentity(before)!==sourceIdentity(after)) {return true;}
  return (hasCargoStops(before) || hasCargoStops(after)) && routeIdentity(before)!==routeIdentity(after);
}
/** @param {any} value */
async function address(value) {
  const text=String(value || "").trim();
  if (!text || /^(undefined|unknown|null)$/iu.test(text)) {throw binWorkflowError(409,"Verify the route's starting location before changing this bin.");}
  const yard=(await query(`SELECT COALESCE(NULLIF(concat_ws(', ',address_line_1,address_line_2,city,region,postal_code),''),yard_code) AS address
    FROM mbt_yards WHERE yard_code=$1 AND active`,[text])).rows[0];
  return yard?.address || text;
}
/** @param {any} stop */
function stopAddress(stop) {return stop.planningAddress || stop.location?.address || stop.yardCode || (typeof stop.location==="string" ? stop.location : "");}

/** @param {any} plan @param {any} truck @param {any} load */
async function routeOrigin(plan,truck,load) {
  const prior=plan.trucks.flatMap((/** @type {any} */ t)=>(t.loads || []).filter((/** @type {any} */ l)=>
    String(l.truckId || t.id)===String(load.truckId || truck.id) && l.id!==load.id
      && Number(l.plannedFinishMinute)<=Number(load.plannedStartMinute) && (l.stops?.length || l.returnOnly)))
    .sort((/** @type {any} */ a,/** @type {any} */ b)=>Number(b.plannedFinishMinute)-Number(a.plannedFinishMinute))[0];
  return address(prior ? prior.returnOnly ? prior.returnYard : stopAddress(prior.stops.at(-1))
    : load.truckStartYard || load.switchYard || truck.base);
}

/** @param {any} stop @param {any} driver */
function stayMinutes(stop,driver) {
  const saved=stop.timing && Number(stop.timing.depart)-Number(stop.timing.arrival);
  const value=stop.stopTimeOverrideMinutes ?? saved ?? (stop.yardCode ? driver.own_yard_fixed_minutes : driver.delivery_fixed_minutes);
  const minutes=Math.ceil(Number(value));
  if (!Number.isFinite(minutes) || minutes<0 || minutes>1440) {throw binWorkflowError(409,"Verify BIN stop service times before changing its route.");}
  return minutes;
}

/** @param {any} load @param {number[]} legs @param {number[]} stays @param {Set<string>} changed */
export function fitBinSelectionRoute(load,legs,stays,changed) {
  let cursor=Number(load.plannedStartMinute);
  for (const [index,stop] of load.stops.entries()) {
    const earliest=cursor+Number(legs[index]);
    if (!changed.has(stop.mbt?.visitId) && stop.timing) {
      if (earliest>stop.timing.arrival) {throw binWorkflowError(409,"The new pickup route does not fit before the next scheduled stop.");}
      cursor=Number(stop.timing.depart);continue;
    }
    const arrival=Math.max(earliest,Number(stop.timing?.arrival || 0)),depart=arrival+Number(stays[index]);
    if (depart>load.plannedFinishMinute) {throw binWorkflowError(409,"The new pickup route does not fit this load's finish time. Adjust its schedule first.");}
    stop.timing={arrival,depart};cursor=depart;
  }
}

/** @param {any} load @param {any} plan @param {any} truck @param {any[]} items @param {any} input @param {any} boundary */
async function refreshRoute(load,plan,truck,items,input,boundary) {
  if (!boundary.routeEstimator) {throw binWorkflowError(409,"A current route estimate is required for this changed pickup source.");}
  const driver=(await query("SELECT * FROM dispatch_drivers WHERE id=$1",[load.driverId || truck.driverId])).rows[0];
  const stays=load.stops.map((/** @type {any} */ s)=>stayMinutes(s,driver));
  const stops=[{location:await routeOrigin(plan,truck,load),stayMinutes:0}];
  for (const [index,stop] of load.stops.entries()) {stops.push({location:await address(stopAddress(stop)),stayMinutes:stays[index]});}
  const departure=(await query(`SELECT (($1::date+$2::int*interval '1 minute') AT TIME ZONE 'America/Toronto') AS at`,[plan.planDate,load.plannedStartMinute])).rows[0].at;
  const estimate=await boundary.routeEstimator({stops,departureTime:departure.toISOString(),reason:"confirm",actorId:input.actor.operatorId,
    sessionId:input.plans.find((/** @type {any} */ p)=>p.planId===plan.id)?.sessionId,
    allowTolls:Boolean(load.allowTolls),travelTimePercent:Number(truck.travelTimePercent || 0)});
  if (estimate?.source!=="google_routes_v2" || !Array.isArray(estimate.legMinutes) || estimate.legMinutes.length!==load.stops.length
    || estimate.legMinutes.some((/** @type {any} */ n)=>!Number.isFinite(n) || n<0)) {
    throw binWorkflowError(409,"The changed pickup route could not be verified. Retry when route estimates are available.");
  }
  const legs=estimate.legMinutes.map((/** @type {number} */ n,/** @type {number} */ i)=>stops[i]?.location===stops[i+1]?.location?0:n);
  fitBinSelectionRoute(load,legs,stays,new Set(items.map(i=>i.visit.service_visit_id)));
  load.routeEstimate=null;
  load.binSelectionRouteCheck={source:estimate.source,checkedAt:new Date().toISOString(),stops,legMinutes:legs};
  await syncAssignmentStops(load,items);
}

/** @param {any} load @param {any[]} items */
async function syncAssignmentStops(load,items) {
  for (const item of items) {
    const stops=load.stops.filter((/** @type {any} */ s)=>s.mbt?.visitId===item.visit.service_visit_id);
    await query(`UPDATE mbt_service_visits SET dispatch_assignment_snapshot=jsonb_set(dispatch_assignment_snapshot,'{stops}',$2::jsonb)
      WHERE service_visit_id=$1`,[item.visit.service_visit_id,JSON.stringify(stops)]);
    await query(`UPDATE mbt_bin_planning_assignments SET snapshot=jsonb_set(snapshot,'{stops}',$2::jsonb)
      WHERE service_visit_id=$1 AND withdrawn_at IS NULL`,[item.visit.service_visit_id,JSON.stringify(stops)]);
  }
}

/** @param {any} plan @param {any[]} items @param {any} input @param {any} boundary */
export async function refreshBinSelectionRoutes(plan,items,input,boundary) {
  const changed=new Set();
  for (const item of items) {
    const current=(await query("SELECT service_snapshot FROM mbt_service_visits WHERE service_visit_id=$1",[item.visit.service_visit_id])).rows[0];
    if (routeChanged(item.visit.service_snapshot,current.service_snapshot)) {changed.add(item.visit.dispatch_load_id);}
  }
  for (const id of changed) {
    const {load,truck}=planningLoad(plan,id);
    await refreshRoute(load,plan,truck,items.filter(i=>i.visit.dispatch_load_id===id),input,boundary);
  }
}
