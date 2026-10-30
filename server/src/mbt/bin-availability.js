// @ts-check
import {query} from '../db.js';
import {plannedBinAvailability} from './bin-availability-domain.js';
import {binWorkflowAsset,binWorkflowAssetLocation,binWorkflowError} from './bin-order-workflow-repository.js';

/** Saved draft and released plans both describe future custody. Missing plan
 * evidence remains an indefinite hold. Never infer a return from reserved_until.
 * @param {string[]} assetIds */
export async function plannedBinWork(assetIds) {
  if (!assetIds.length) {return [];}
  const {rows}=await query(`WITH holds AS (
    SELECT asset_id,visit_id FROM mbt_bin_workflow_claims WHERE released_at IS NULL AND asset_id=ANY($1::uuid[])
    UNION SELECT asset_id,visit_id FROM mbt_bin_asset_reservations WHERE released_at IS NULL AND asset_id=ANY($1::uuid[])
  ) SELECT h.asset_id,v.service_visit_id AS id,v.visit_reference AS reference,v.service_snapshot,
      v.planned_truck_id AS truck_id,v.dispatch_load_id,v.actual_started_at,p.plan_date::text,s.trucks,
      (p.plan_date::timestamp AT TIME ZONE 'America/Toronto') AS day_start
    FROM holds h LEFT JOIN mbt_service_visits v ON v.service_visit_id=h.visit_id
    LEFT JOIN dispatch_plans p ON p.id::text=v.dispatch_plan_id
    LEFT JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
    WHERE v.status IS NULL OR v.status NOT IN ('completed','cancelled')`,[assetIds]);
  const transport=(await query(`SELECT t.asset_id,t.trip_id AS id,s.source_ref AS reference,
    jsonb_build_object('mandatoryStops',t.route->'stops') AS service_snapshot,t.truck_id,
    t.load_id AS dispatch_load_id,t.actual_started_at,p.plan_date::text,ps.trucks,
    (p.plan_date::timestamp AT TIME ZONE 'America/Toronto') AS day_start
    FROM mbt_transport_trips t JOIN mbt_transport_sources s USING(source_key)
    JOIN dispatch_plans p ON p.id=t.plan_id JOIN dispatch_plan_snapshots ps ON ps.plan_id=p.id
    WHERE t.asset_id=ANY($1::uuid[]) AND t.status NOT IN ('completed','cancelled')`,[assetIds])).rows;
  const work=[...rows,...transport].map(workFromVisit);
  const timed=work.filter(row=>row.start).map(row=>({id:row.id,date:row.planDate,start:row.fromMinute,finish:row.untilMinute}));
  if (timed.length) {
    const times=(await query(`SELECT id,((date::date+start*interval '1 minute') AT TIME ZONE 'America/Toronto') AS start,
      ((date::date+finish*interval '1 minute') AT TIME ZONE 'America/Toronto') AS finish
      FROM jsonb_to_recordset($1::jsonb) AS t(id text,date text,start integer,finish integer)`,[JSON.stringify(timed)])).rows;
    for (const job of work) {
      const time=times.find((/** @type {any} */ row)=>row.id===job.id);
      if (time) {job.start=new Date(time.start).toISOString();job.finish=new Date(time.finish).toISOString();}
    }
  }
  return work;
}

/** @param {any} row */
function visitLoad(row) {
  const truck=row.trucks?.find((/** @type {any} */ t)=>String(t.id)===String(row.truck_id));
  return truck?.loads?.find((/** @type {any} */ l)=>String(l.id)===String(row.dispatch_load_id));
}
/** @param {any} row @param {any} last */
function visitRelease(row,last) {
  const required=row.service_snapshot?.mandatoryStops || [];
  const lastRequired=required.find((/** @type {any} */ s)=>s.actionCode===last?.actionCode);
  const location=lastRequired?.location;
  if (!['return_bin','return_empty_bin','unload_bin'].includes(last?.actionCode) || location?.kind!=='yard') {return null;}
  return String(last.assetId || lastRequired?.assetId)===String(row.asset_id) ? location : null;
}
/** @param {any[]} stops @param {any} load @param {any} dayStart */
function visitTiming(stops,load,dayStart) {
  const fromMinute=stops[0]?.timing?.arrival ?? load?.plannedStartMinute;
  const untilMinute=stops.at(-1)?.timing?.depart ?? load?.plannedFinishMinute;
  const timed=stops.length && [fromMinute,untilMinute].every(Number.isFinite) && dayStart;
  return {start:timed ? new Date(dayStart).toISOString() : null,finish:/** @type {string | null} */ (null),fromMinute,untilMinute};
}
/** @param {any} row */
function workFromVisit(row) {
  const load=visitLoad(row);
  const stops=load?.stops?.filter((/** @type {any} */ s)=>String(s.mbt?.visitId)===String(row.id)) || [];
  return {id:String(row.id),assetId:String(row.asset_id),reference:row.reference,
    truckId:String(row.truck_id),...visitTiming(stops,load,row.day_start),
    planDate:row.plan_date,release:visitRelease(row,stops.at(-1))};
}

/** Existing explicit exchange/handoff chains keep their action-level guards.
 * @param {string} visitId @param {string} assetId */
export async function connectedBinVisits(visitId,assetId) {
  const {rows}=await query(`WITH RECURSIVE edges(a,b) AS (
    SELECT d.dependent_visit_id,d.prerequisite_visit_id FROM mbt_bin_workflow_dependencies d
    JOIN mbt_bin_order_parts p ON p.visit_id=d.dependent_visit_id
    JOIN mbt_bin_order_parts q ON q.visit_id=d.prerequisite_visit_id WHERE p.asset_id=$2 AND q.asset_id=$2
    UNION SELECT l.delivery_visit_id,l.trip_id FROM mbt_transport_delivery_links l JOIN mbt_transport_trips t USING(trip_id)
    WHERE l.released_at IS NULL AND t.asset_id=$2
  ), ancestors(id) AS (SELECT $1::uuid UNION SELECT b FROM edges JOIN ancestors ON a=id),
  descendants(id) AS (SELECT $1::uuid UNION SELECT a FROM edges JOIN descendants ON b=id)
  SELECT id FROM ancestors UNION SELECT id FROM descendants`,[visitId,assetId]);
  return rows.map((/** @type {any} */ r)=>String(r.id));
}

/** @param {any} asset @param {any} options @param {any[]} [work] */
export async function binAvailability(asset,options,work) {
  const jobs=work || await plannedBinWork([String(asset.asset_id)]);
  const exclude=new Set(options.exclude || []);
  const location=await binWorkflowAssetLocation(asset);
  const empty=['available','at_dump'].includes(asset.lifecycle_status)
    || (asset.lifecycle_status==='reserved' && asset.location_kind==='yard')
    || (asset.lifecycle_status==='on_truck' && /dump|empty/u.test(String(asset.movement_type)));
  const unusable=asset.active===false || asset.under_maintenance===true || ['lost','retired','maintenance'].includes(asset.lifecycle_status);
  const workForAsset=jobs.filter(j=>j.assetId===String(asset.asset_id) && !exclude.has(j.id));
  const available=plannedBinAvailability({actual:{empty,location,unusable},work:workForAsset,
    at:choiceStart(options,workForAsset),until:options.until,latestPickupAt:options.latestPickupAt,truckId:options.truckId});
  if (!available.available && !empty && asset.location_kind==='truck') {
    return {...available,reason:'The bin aboard this truck has no confirmed empty-bin movement or completed dump, and no compatible planned return.'};
  }
  return available;
}

/** A day-wide transport selection follows work already booked on that day.
 * Exact assignment validation always uses the requested stop times.
 * @param {any} options @param {any[]} work */
function choiceStart(options,work) {
  if (!options.preferPlannedReturn) {return options.at;}
  const start=Date.parse(options.at),finish=Date.parse(options.latestPickupAt);
  const scheduled=work.map(row=>Date.parse(row.start)).filter(at=>at>=start && at<=finish).sort((a,b)=>a-b);
  return scheduled.length ? new Date(Number(scheduled[0])).toISOString() : options.at;
}

/** @param {any} availability */
export function availableBinSource(availability) {
  if (!availability.available) {throw binWorkflowError(409,availability.reason || 'This bin has no available planned return.');}
  return {...availability.location,...(availability.projected ? {planned:true,availabilityPredecessorId:availability.predecessorId,
    availableAt:availability.availableAt,predecessorReference:availability.predecessorReference} : {})};
}

/** @param {any[]} assets @param {any} options */
export async function projectBinChoices(assets,options) {
  const work=await plannedBinWork(assets.map(a=>String(a.asset_id)));
  const result=[];
  for (const asset of assets) {
    const availability=await binAvailability(asset,options,work);
    result.push({...asset,availability,source_address:availability.available ? availability.location.address : asset.source_address});
  }
  return result;
}

/** Validate both sides after any planning mutation, within the fleet transaction.
 * A lost predecessor must fail even when its claim was just removed.
 * @param {string[]} assetIds */
export async function assertBinAvailabilityDependencies(assetIds) {
  if (!assetIds.length) {return;}
  const {rows}=await query(`SELECT * FROM mbt_service_visits WHERE dispatch_plan_id IS NOT NULL
    AND actual_started_at IS NULL AND status NOT IN ('completed','cancelled')
    AND expected_asset_id=ANY($1::uuid[]) AND service_snapshot->'binWorkflow'->>'role'='delivery'`,[assetIds]);
  const work=await plannedBinWork(assetIds);
  const transports=(await query(`SELECT trip_id AS service_visit_id,asset_id AS expected_asset_id,truck_id AS planned_truck_id,
    source_key AS visit_reference,route->'source' AS source FROM mbt_transport_trips
    WHERE plan_id IS NOT NULL AND actual_started_at IS NULL AND status NOT IN ('completed','cancelled') AND asset_id=ANY($1::uuid[])`,[assetIds])).rows;
  rows.push(...transports.map((/** @type {any} */ t)=>({...t,transport:true,service_snapshot:{binWorkflow:{source:t.source}}})));
  for (const visit of rows) {
    const source=visit.service_snapshot.binWorkflow.source;
    if (source?.planned && !source.availabilityPredecessorId) {continue;}
    const own=work.find(w=>w.id===String(visit.service_visit_id));
    if (!own) {continue;}
    const asset=await binWorkflowAsset(String(visit.expected_asset_id),true);
    const availability=await binAvailability(asset,{at:own.start,until:own.finish,truckId:visit.planned_truck_id,
      exclude:await connectedBinVisits(String(visit.service_visit_id),String(asset.asset_id))},work);
    const next=availableBinSource(availability);
    await assertBinSourceMatches(source,next,`The planned return supplying ${visit.visit_reference} changed. Adjust its dependent order first.`);
  }
}

/** A completed predecessor yields to actual custody at the same location.
 * @param {any} source @param {any} next @param {string} [message] */
export async function assertBinSourceMatches(source,next,message='The planned bin return or pickup location changed. Refresh the route.') {
  if (!source) {throw binWorkflowError(409,message);}
  const same=source.kind===next.kind && String(source.id)===String(next.id);
  if (same && (!source.availabilityPredecessorId || source.availabilityPredecessorId===next.availabilityPredecessorId)) {return;}
  const completed=same && source.availabilityPredecessorId && (await query(`SELECT 1 FROM mbt_service_visits
    WHERE service_visit_id=$1 AND status='completed' UNION ALL SELECT 1 FROM mbt_transport_trips
    WHERE trip_id=$1 AND status='completed'`,[source.availabilityPredecessorId])).rowCount;
  if (!completed) {throw binWorkflowError(409,next.availabilityPredecessorId ? message : `The bin has moved since this route was configured. ${message}`);}
}
