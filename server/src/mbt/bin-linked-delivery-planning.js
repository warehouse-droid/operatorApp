// @ts-check
import {query} from '../db.js';
import {planningError,lockPlanningVisit,planningText} from './bin-planning-repository.js';

/** Only unfinished collections couple the two planning assignments.
 * @param {string[]} visitIds */
export async function linkedBinRoutes(visitIds) {
  if (!visitIds.length) {return [];}
  return (await query(`SELECT c.visit_id AS "collectionId",d.visit_id AS "deliveryId",
      c.display_reference AS "collectionReference",d.display_reference AS "deliveryReference",
      c.asset_id AS "collectionAssetId",d.asset_id AS "deliveryAssetId",
      dv.revision::int AS "deliveryRevision",dv.status AS "deliveryStatus"
    FROM mbt_bin_order_parts c JOIN mbt_bin_order_parts d ON d.visit_id=c.linked_delivery_visit_id
    JOIN mbt_service_visits cv ON cv.service_visit_id=c.visit_id
    JOIN mbt_service_visits dv ON dv.service_visit_id=d.visit_id
    WHERE (c.visit_id=ANY($1::uuid[]) OR d.visit_id=ANY($1::uuid[]))
      AND cv.status NOT IN ('completed','cancelled')
    UNION ALL SELECT t.trip_id,d.visit_id,s.source_ref||' · Trip '||t.trip_number,d.display_reference,t.asset_id,d.asset_id,
      dv.revision::int,dv.status FROM mbt_transport_delivery_links l JOIN mbt_transport_trips t USING(trip_id)
      JOIN mbt_transport_sources s USING(source_key) JOIN mbt_bin_order_parts d ON d.visit_id=l.delivery_visit_id
      JOIN mbt_service_visits dv ON dv.service_visit_id=d.visit_id WHERE l.released_at IS NULL AND t.status<>'cancelled'
      AND (t.trip_id=ANY($1::uuid[]) OR d.visit_id=ANY($1::uuid[])) ORDER BY "collectionId"`,[visitIds])).rows;
}

/** @param {any} link */
function assertLinkedBin(link) {
  if (link.collectionAssetId!==link.deliveryAssetId || ['completed','cancelled'].includes(link.deliveryStatus)) {
    throw planningError(409,'MBT_BIN_LINK_CHANGED','The linked delivery or physical bin changed. Refresh the route.');
  }
}

/** Pure intent expansion; explicit revisions/timings remain untouched.
 * @param {any[]} loads @param {any[]} links */
export function expandLinkedBinLoads(loads,links) {
  const expanded=structuredClone(loads);
  for (const link of links) {
    assertLinkedBin(link);
    const source=expanded.find(load=>load.visits.some((/** @type {any} */ v)=>v.visitId===link.collectionId));
    const target=expanded.find(load=>load.visits.some((/** @type {any} */ v)=>v.visitId===link.deliveryId));
    if (!source) {
      throw planningError(409,'MBT_BIN_LINK_REQUIRED',`Plan ${link.deliveryReference} with its linked collection ${link.collectionReference}.`);
    }
    const index=source.visits.findIndex((/** @type {any} */ v)=>v.visitId===link.collectionId);
    if (target && (source!==target || target.visits.findIndex((/** @type {any} */ v)=>v.visitId===link.deliveryId)<=index)) {
      throw planningError(409,'MBT_BIN_LINK_SEQUENCE','Keep the linked delivery after its collection and dump in the same load.');
    }
    if (!target) {
      source.visits.splice(index+1,0,{visitId:link.deliveryId,expectedVisitRevision:link.deliveryRevision,
        assetAssignments:[],stopOverrides:[],stopTimings:[]});
    }
  }
  return expanded;
}

/** The caller holds the shared fleet/date fence. All members use existing
 * authoritative assignment/withdrawal commands in that transaction.
 * @param {any} input @param {any} boundary @param {any} commands */
export async function planLinkedBinCommand(input,boundary,commands) {
  const selected=await lockPlanningVisit(input.visitId,input.expectedVisitRevision);
  const [link]=await linkedBinRoutes([input.visitId]);
  if (link) {assertLinkedBin(link);}
  if (link && input.action==='assign' && input.visitId!==link.collectionId) {
    throw planningError(409,'MBT_BIN_LINK_REQUIRED',`Plan ${link.collectionReference}; its linked delivery ${link.deliveryReference} is included automatically.`);
  }
  const ids=link ? [link.collectionId,link.deliveryId] : [input.visitId];
  const visits=[];
  for (const id of ids) {visits.push(id===input.visitId ? selected : await lockPlanningVisit(id));}
  const revisions=new Map(visits.map(v=>[String(v.service_visit_id),Number(v.revision)]));
  const results=new Map();
  if (input.action!=='assign') {
    await withdrawLinkedVisits(input,visits,commands,revisions,results);
  }
  if (input.action!=='cancel') {
    await assignLinkedVisits(input,boundary,commands,ids,revisions,results);
  }
  return {...results.get(input.visitId),linkedVisitIds:ids};
}

/** @param {any} input @param {any[]} visits @param {any} commands
 * @param {Map<string,number>} revisions @param {Map<string,any>} results */
async function withdrawLinkedVisits(input,visits,commands,revisions,results) {
  for (const visit of visits) {
    if (!visit.dispatch_plan_id && visit.service_visit_id!==input.visitId) {continue;}
    const result=await commands.cancelVisit({...input,visitId:String(visit.service_visit_id),expectedVisitRevision:revisions.get(visit.service_visit_id)});
    revisions.set(result.visitId,result.visitRevision);results.set(result.visitId,result);
  }
}

/** @param {any} input @param {any} boundary @param {any} commands @param {string[]} ids
 * @param {Map<string,number>} revisions @param {Map<string,any>} results */
async function assignLinkedVisits(input,boundary,commands,ids,revisions,results) {
  const loadId=input.action==='assign' ? input.loadId : planningText(input.toLoadId,'Destination load');
  for (const id of ids) {
    const result=await commands.assignVisit({...input,visitId:id,loadId,expectedVisitRevision:revisions.get(id),
      assetAssignments:input.action==='assign' && id===input.visitId ? input.assetAssignments : [],
      idempotencyKey:`${input.idempotencyKey}:linked:${id}`},boundary,
      id===input.visitId ? input.stopOverrides || [] : [],id===input.visitId ? input.stopTimings || [] : []);
    results.set(id,result);
  }
}
