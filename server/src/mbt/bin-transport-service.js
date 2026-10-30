// @ts-check
import crypto from 'node:crypto';
import {query} from '../db.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from '../dispatch-fleet-status.js';
import {executeMbtCommand} from './command-repository.js';
import {binWorkflowAsset} from './bin-order-workflow-repository.js';
import {binAvailability,availableBinSource,projectBinChoices} from './bin-availability.js';
import {allocateTransportLines,transportTripWeight,transportError} from './bin-transport-domain.js';
import {readTransportSource,assertTransportSourceOpen,transportLineProgress} from './bin-transport-sources.js';
import {buildTransportRoute} from './bin-transport-route.js';
import {linkTransportDelivery,unlinkTransportDelivery,transportDeliveryChoices} from './bin-transport-delivery.js';

/** @param {any} actor */
export function assertTransportPlanner(actor) {
  if (!actor?.operatorId || !actor.roles?.some((/** @type {string} */ r)=>['admin','dispatcher'].includes(r))) {
    throw Object.assign(transportError('Admin or Dispatcher access is required.'),{status:403});
  }
}

/** @param {string} key */
async function sourceTrips(key) {return (await query('SELECT * FROM mbt_transport_trips WHERE source_key=$1 ORDER BY trip_number',[key])).rows;}

/** @param {any} row @param {string} reference */
export function transportTripView(row,reference) {
  return {tripId:row.trip_id,sourceRef:reference,tripNumber:Number(row.trip_number),assetId:row.asset_id,
    allocations:row.allocations,weightLbs:Number(row.weight_lbs),route:row.route,status:row.status,revision:Number(row.revision),
    planId:row.plan_id ? String(row.plan_id) : null,loadId:row.load_id,generation:Number(row.generation),
    cargoDeliveredAt:row.cargo_delivered_at,actualStartedAt:row.actual_started_at};
}

/** @param {any} input */
async function planningWindow(input) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(input.planDate))) {throw transportError('Choose the planning date.');}
  return {...(await query(`SELECT ($1::date::timestamp AT TIME ZONE 'America/Toronto') AS at,
    (($1::date+interval '1 day'-interval '1 millisecond') AT TIME ZONE 'America/Toronto') AS "latestPickupAt"`,[input.planDate])).rows[0],preferPlannedReturn:true};
}

/** @param {any} input @param {any} [boundary] */
export async function getTransportOptions(input,boundary={}) {
  const source=await readTransportSource(String(input.sourceRef),boundary),trips=await sourceTrips(source.sourceKey);
  const stored=(await query('SELECT * FROM mbt_transport_sources WHERE source_key=$1',[source.sourceKey])).rows[0];
  const assets=(await query(`SELECT a.*,s.lifecycle_status,s.location_kind,s.location_reference,s.current_address,s.yard_id,
    s.customer_site_profile_id,s.dump_site_id,s.truck_id,s.revision AS state_revision,m.movement_type,b.type_code,
    b.maximum_payload_kg FROM mbt_bin_assets a JOIN mbt_bin_asset_state s USING(asset_id)
    JOIN mbt_bin_types b USING(bin_type_id) JOIN mbt_bin_movements m ON m.movement_id=s.last_movement_id
    WHERE a.active AND NOT a.under_maintenance AND b.active ORDER BY a.asset_code`)).rows;
  const yards=(await query('SELECT yard_id AS id,yard_code AS code,display_name AS name FROM mbt_yards WHERE active ORDER BY yard_code')).rows;
  const options=await projectBinChoices(assets,{...await planningWindow(input),exclude:input.tripId?[input.tripId]:[]});
  return {source:source.snapshot,fingerprint:source.fingerprint,revision:Number(stored?.revision || 0),
    lines:transportLineProgress(source.snapshot.lines,trips),trips:trips.map((/** @type {any} */ t)=>transportTripView(t,source.snapshot.ref)),
    assets:options,yards,deliveries:await transportDeliveryChoices(input.tripId),sourceChanged:Boolean(stored?.claimed && stored.source_fingerprint!==source.fingerprint)};
}

/** @param {any} source @param {any} input */
async function lockTransportSource(source,input) {
  const stored=(await query('SELECT * FROM mbt_transport_sources WHERE source_key=$1 FOR UPDATE',[source.sourceKey])).rows[0];
  if (!Number.isSafeInteger(input.expectedSourceRevision) || input.expectedSourceRevision!==Number(stored?.revision || 0)
      || input.sourceFingerprint!==source.fingerprint || (stored?.claimed && stored.source_fingerprint!==source.fingerprint)) {
    throw transportError('The original order or its trips changed. Refresh the source order before saving.','MBT_TRANSPORT_SOURCE_CHANGED');
  }
  await assertTransportSourceOpen(source);
  await query(`INSERT INTO mbt_transport_sources(source_key,source_ref,source_kind,source_snapshot,source_fingerprint,created_by,updated_by)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$6) ON CONFLICT(source_key) DO UPDATE SET source_snapshot=EXCLUDED.source_snapshot,
    source_fingerprint=EXCLUDED.source_fingerprint,claimed=true,revision=mbt_transport_sources.revision+1,
    updated_by=EXCLUDED.updated_by,updated_at=now()`,[source.sourceKey,source.snapshot.ref,source.snapshot.kind,
    JSON.stringify(source.snapshot),source.fingerprint,input.actor.operatorId]);
  return stored;
}

/** @param {any} trip @param {any} input */
function assertEditableTrip(trip,input) {
  if (!trip || Number(trip.revision)!==input.expectedRevision || trip.plan_id || trip.actual_started_at || trip.status!=='ready') {
    throw transportError('Unplan this trip before editing. Started and completed trips retain their route and quantities.');
  }
}

/** @param {any} prior @param {any[]} trips */
function tripNumber(prior,trips) {return prior?.trip_number || Math.max(0,...trips.map(t=>Number(t.trip_number)))+1;}

/** @param {any} source @param {any} input @param {any[]} trips */
async function transportPayload(source,input,trips) {
      const allocations=allocateTransportLines(source.snapshot.lines,trips.filter((/** @type {any} */ t)=>t.trip_id!==input.tripId && t.status!=='cancelled')
        .flatMap((/** @type {any} */ t)=>t.allocations),input.allocations);
      const asset=await binWorkflowAsset(String(input.assetId),true);
      const type=(await query('SELECT maximum_payload_kg FROM mbt_bin_types WHERE bin_type_id=$1 AND active',[asset.bin_type_id])).rows[0];
      const weight=transportTripWeight({allocations,weightLbs:input.weightLbs,maximumPayloadLbs:Number(type?.maximum_payload_kg)*2.2046226218});
      const available=await binAvailability(asset,{...await planningWindow(input),exclude:input.tripId?[input.tripId]:[]});
      const route=await buildTransportRoute(source,input,availableBinSource(available),weight);
  return {allocations,asset,weight,route};
}

/** @param {any} input @param {any} [boundary] */
export async function saveTransportTrip(input,boundary={}) {
  assertTransportPlanner(input.actor);
  const {actor,idempotencyKey,correlationId,requestId,...payload}=input;
  const result=await executeMbtCommand({actor,idempotencyKey,correlationId,requestId,commandName:'mbt.transport.save',payload,
    mutation:async()=>{
      await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
      const source=await readTransportSource(String(input.sourceRef),boundary);
      const before=await lockTransportSource(source,input),trips=await sourceTrips(source.sourceKey);
      const prior=input.tripId ? trips.find((/** @type {any} */ t)=>t.trip_id===input.tripId) : null;
      if (input.tripId) {assertEditableTrip(prior,input);}
      const {allocations,asset,weight,route}=await transportPayload(source,input,trips);
      const tripId=prior?.trip_id || crypto.randomUUID(),number=tripNumber(prior,trips);
      const trip=(await query(`INSERT INTO mbt_transport_trips(trip_id,source_key,trip_number,asset_id,allocations,weight_lbs,route,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$8) ON CONFLICT(trip_id) DO UPDATE SET asset_id=EXCLUDED.asset_id,
        allocations=EXCLUDED.allocations,weight_lbs=EXCLUDED.weight_lbs,route=EXCLUDED.route,revision=mbt_transport_trips.revision+1,
        updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[tripId,source.sourceKey,number,asset.asset_id,
        JSON.stringify(allocations),weight,JSON.stringify(route),actor.operatorId])).rows[0];
      await saveTransportSteps(trip);
      await linkTransportDelivery(trip,actor.operatorId);
      const revision=Number(before?.revision || 0)+1,body={trip:transportTripView(trip,source.snapshot.ref),sourceRevision:revision};
      return {status:prior?200:201,body,audit:transportAudit('saved',tripId,prior || {},body,actor,
        Number(prior?.revision || 1),Number(trip.revision))};
    }});
  return JSON.parse(JSON.stringify(result));
}

/** @param {any} trip */
async function saveTransportSteps(trip) {
  const existing=(await query('SELECT * FROM mbt_transport_steps WHERE trip_id=$1',[trip.trip_id])).rows;
  await query('DELETE FROM mbt_transport_steps WHERE trip_id=$1',[trip.trip_id]);
  for (const stop of trip.route.stops) {
    const id=existing.find((/** @type {any} */ s)=>s.action_code===stop.actionCode)?.step_id || crypto.randomUUID();
    await query(`INSERT INTO mbt_transport_steps(step_id,trip_id,sequence_number,action_code,snapshot)
      VALUES($1,$2,$3,$4,$5::jsonb)`,[id,trip.trip_id,stop.sequence,stop.actionCode,JSON.stringify(stop)]);
  }
}

/** @param {string} action @param {string} id @param {any} before @param {any} after @param {any} actor @param {number} oldRevision @param {number} revision */
function transportAudit(action,id,before,after,actor,oldRevision,revision) {
  return {action:`mbt.transport.${action}`,entityType:'mbt_transport_trip',entityId:id,beforeState:before,afterState:after,
    reason:`Dispatcher ${actor.operatorId} ${action} source-linked BIN transport`,revisionBefore:oldRevision,revisionAfter:revision,source:'mbt-planning'};
}

/** @param {any} input */
export async function cancelTransportTrip(input) {
  assertTransportPlanner(input.actor);
  const {actor,idempotencyKey,correlationId,requestId,...payload}=input;
  return executeMbtCommand({actor,idempotencyKey,correlationId,requestId,commandName:'mbt.transport.cancel',payload,mutation:async()=>{
    await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
    const trip=(await query('SELECT * FROM mbt_transport_trips WHERE trip_id=$1 FOR UPDATE',[input.tripId])).rows[0];
    assertEditableTrip(trip,input);
    await unlinkTransportDelivery(trip.trip_id,actor.operatorId);
    const saved=(await query("UPDATE mbt_transport_trips SET status='cancelled',revision=revision+1,updated_by=$2,updated_at=now() WHERE trip_id=$1 RETURNING *",
      [trip.trip_id,actor.operatorId])).rows[0];
    await query(`UPDATE mbt_transport_sources s SET revision=revision+1,updated_by=$2,updated_at=now(),
      claimed=EXISTS(SELECT 1 FROM mbt_transport_trips t WHERE t.source_key=s.source_key AND t.status<>'cancelled') WHERE source_key=$1`,[trip.source_key,actor.operatorId]);
    return {status:200,body:{tripId:trip.trip_id,status:saved.status,revision:Number(saved.revision)},
      audit:transportAudit('cancelled',trip.trip_id,trip,saved,actor,Number(trip.revision),Number(saved.revision))};
  }});
}
