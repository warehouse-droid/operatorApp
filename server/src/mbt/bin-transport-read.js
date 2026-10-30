// @ts-check
import {query} from '../db.js';
import {planningDate,readPlanningPlan} from './bin-planning-repository.js';
import {aggregateRoutingIds} from './aggregate-routing.js';
import {transportSourceKind,transportError} from './bin-transport-domain.js';
import {transportSourceOrders,transportSourceFromOrder,transportLineProgress} from './bin-transport-sources.js';
import {projectMbtBinPlanningCard} from './bin-dispatch-service.js';

/** @param {any} trip */
function transportAssignment(trip) {
  return {loadId:trip?.load_id || null,dispatchPlanned:Boolean(trip?.plan_id),dispatchPlanId:trip?.plan_id?String(trip.plan_id):null,
    dispatchPlanDate:trip?.plan_date || null,dispatchLoadId:trip?.load_id || null};
}
/** @param {any} snapshot @param {any[]} lines @param {any} trip */
function transportDetails(snapshot,lines,trip) {
  return {sourceRef:snapshot.ref,sourceOnly:!trip,tripNumber:trip?.trip_number || null,kind:snapshot.kind,
    lines,allocations:trip?.allocations || [],weightLbs:Number(trip?.weight_lbs || 0),windowStart:snapshot.windowStart,windowEnd:snapshot.windowEnd,
    reviewRequired:false,linkedDeliveryVisitId:trip?.route.returnDestination.kind==='delivery'?trip.route.returnDestination.visitId:null};
}
/** @param {string} id @param {any} trip */
function transportRequirements(id,trip) {
  const status=trip?.status || 'ready',type=trip?.type_code || '';
  const assets=trip?[{assetRole:'expected',reservationSlot:'outgoing',exactAssetId:trip.asset_id,
    exactAssetCode:trip.asset_code,binTypeId:trip.bin_type_id,binTypeCode:type,expectedStateRevision:Number(trip.state_revision)}]:[];
  return {visitId:id,visitRevision:Number(trip?.revision || 0),workKind:'transport',status,
    frontLeg:{dispatchable:Boolean(trip && status==='ready' && !trip.plan_id)},assetRequirements:assets,assetChoices:[],
    binTypeCode:type,truckRequirements:{truckType:'bin',minimumSlots:1,supportedBinTypeCode:type}};
}
/** @param {any} snapshot @param {any[]} lines @param {any} [trip] */
function transportCard(snapshot,lines,trip) {
  const id=trip?.trip_id || `transport-source:${snapshot.ref}`,reference=trip?`${snapshot.ref} · Trip ${trip.trip_number}`:snapshot.ref;
  return {id,type:'BIN',displayReference:reference,customer:snapshot.customer,address:snapshot.address,
    serviceAction:'mbr_agg',scheduledWindow:{startAt:null,endAt:null},stops:trip?.route.stops || [],
    transport:transportDetails(snapshot,lines,trip),mbt:transportRequirements(id,trip),...transportAssignment(trip),
    blockedReason:trip?'':'Save the bin, quantities and route in Plan transport.'};
}

/** @param {any} trip @param {Map<string,any>} plans @param {any[]} lines */
async function assignedTransportCard(trip,plans,lines) {
  const card=transportCard(trip.source_snapshot,lines,trip);
  if (!trip.plan_id) {return card;}
  const id=String(trip.plan_id);
  if (!plans.has(id)) {plans.set(id,await readPlanningPlan(id));}
  const plan=plans.get(id);
  for (const truck of plan?.trucks || []) {
    const load=truck.loads.find((/** @type {any} */ row)=>String(row.id)===trip.load_id);
    if (load) {Object.assign(card,{dispatchTruckPlate:truck.plate,dispatchLoadName:load.name,dispatchPlanDate:plan.planDate});break;}
  }
  return card;
}

const tripSelect=`SELECT t.*,s.source_snapshot,s.source_ref,a.asset_code,a.bin_type_id,b.type_code,st.revision AS state_revision,
  to_char(p.plan_date,'YYYY-MM-DD') AS plan_date FROM mbt_transport_trips t JOIN mbt_transport_sources s USING(source_key)
  JOIN mbt_bin_assets a USING(asset_id) JOIN mbt_bin_types b USING(bin_type_id) JOIN mbt_bin_asset_state st USING(asset_id)
  LEFT JOIN dispatch_plans p ON p.id=t.plan_id`;

/** @param {any[]} items @param {any} source @param {any[]} lines */
function appendSourceCard(items,source,lines) {
    if (lines.some(l=>Number(l.remaining)>0) && !source.order.dispatchPlanned) {
      items.push(transportCard(source.snapshot,lines));
    } else if (source.order.dispatchPlanned && ['aggregate','frontdesk_aggregate'].includes(source.snapshot.kind)) {
      const card=transportCard(source.snapshot,lines);
      card.blockedReason='Review existing Dispatch assignment: this order requires BIN transport.';
      card.transport.reviewRequired=true;items.push(card);
    }
}

/** @param {any} input @param {any} [boundary] */
export async function getTransportPlanning(input,boundary={}) {
  const date=planningDate(input.planDate),search=String(input.search || '').trim().slice(0,120);
  const orders=await transportSourceOrders({search},boundary),rules=await aggregateRoutingIds();
  /** @type {Map<string,any>} */
  const sources=new Map(orders.map((/** @type {any} */ order)=>{
    const source=transportSourceFromOrder(order,transportSourceKind(order,rules) || '');return [source.sourceKey,source];
  }));
  const trips=(await query(`${tripSelect} WHERE ($1='' OR concat_ws(' ',s.source_ref,s.source_snapshot->>'customer',a.asset_code) ILIKE '%'||$1||'%'
    OR EXISTS(SELECT 1 FROM mbt_transport_delivery_links l JOIN mbt_bin_order_parts d ON d.visit_id=l.delivery_visit_id
      WHERE l.trip_id=t.trip_id AND l.released_at IS NULL AND d.display_reference ILIKE '%'||$1||'%'))
    AND (t.status<>'cancelled' OR $1<>'') ORDER BY s.source_ref,t.trip_number`,[search])).rows;
  const plans=new Map(),items=[],assigned=[];
  for (const trip of trips) {
    if (!sources.has(trip.source_key)) {sources.set(trip.source_key,{snapshot:trip.source_snapshot,order:{}});}
  }
  for (const [key,source] of sources) {
    const rows=trips.filter((/** @type {any} */ t)=>t.source_key===key),lines=transportLineProgress(source.snapshot.lines,rows);
    appendSourceCard(items,source,lines);
    for (const trip of rows) {
      const card=await assignedTransportCard(trip,plans,lines);
      if (search || (!trip.plan_id && trip.status==='ready')) {items.push(card);}
      if (card.dispatchPlanDate===date) {assigned.push(card);}
    }
  }
  return transportPoolPage(input,items,assigned);
}

/** @param {any} input @param {any[]} items @param {any[]} assigned */
async function transportPoolPage(input,items,assigned) {
  const offset=Math.min(1000000,Math.max(0,Number(input.offset)||0)),limit=Math.min(100,Math.max(1,Number(input.limit)||100));
  const visible=items.slice(offset,offset+limit),linked=[];
  const ids=[...new Set([...visible,...assigned].map(card=>card.transport.linkedDeliveryVisitId).filter(Boolean))];
  if (ids.length) {
    for (const visit of (await query('SELECT * FROM mbt_service_visits WHERE service_visit_id=ANY($1::uuid[])',[ids])).rows) {
      linked.push(await projectMbtBinPlanningCard(visit));
    }
  }
  return {pool:{items:visible,total:items.length,nextOffset:offset+limit<items.length?offset+limit:null},assigned,linked};
}

/** @param {string} tripId */
export async function getTransportPlanningTrip(tripId) {
  const trip=(await query(`${tripSelect} WHERE t.trip_id=$1`,[tripId])).rows[0];
  if (!trip) {throw transportError('The transport trip was not found.');}
  return {visit:await assignedTransportCard(trip,new Map(),[])};
}
