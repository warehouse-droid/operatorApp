// @ts-check
import {query} from '../db.js';
import {binWorkflowError,binWorkflowParts} from './bin-order-workflow-repository.js';

/** Withdrawn generations are history, not current planning locks. @param {any} visit */
export function binWorkLocked(visit) {
  return Boolean(visit?.dispatch_plan_id || visit?.actual_started_at || visit?.actual_completed_at
    || visit?.active_assignment || visit?.started_steps
    || ['in_progress','evidence_pending','completed','cancelled'].includes(visit?.status));
}
/** @param {any} root @param {any[]} parts */
export function workflowEditPermissions(root,parts) {
  const closed=['completed','cancelled'].includes(root.status) || root.rental_status==='closed';
  const rootLocked=closed || Boolean(root.dispatch_plan_id || root.active_assignment)
    || (!parts.length && binWorkLocked(root));
  const editable=(/** @type {string} */ role)=>!rootLocked && !parts.some(p=>p.part_role===role && (binWorkLocked(p) || p.incoming_link));
  const delivery=root.order_kind!=='collection' && editable('delivery');
  const collection=root.order_kind!=='delivery' && editable('collection');
  const sequence=!rootLocked && parts.every(p=>!binWorkLocked(p) && !p.incoming_link);
  return {sequence,delivery,collection,reason:editLockReason(rootLocked,parts)};
}
/** @param {boolean} rootLocked @param {any[]} parts */
function editLockReason(rootLocked,parts) {
  if (rootLocked) {return 'Started, completed or planned BIN work retains its existing instructions.';}
  if (parts.some(p=>p.incoming_link)) {return 'This delivery is linked to another rental. Change its bin route from the linked Collection.';}
  return 'Unplan the affected BIN leg before changing its route.';
}
/** @param {string[]} ids */
export async function workflowEditGuards(ids) {
  return (await query(`SELECT v.*,
    EXISTS(SELECT 1 FROM mbt_bin_planning_assignments a WHERE a.service_visit_id=v.service_visit_id AND a.withdrawn_at IS NULL) AS active_assignment,
    EXISTS(SELECT 1 FROM mbt_visit_steps s WHERE s.service_visit_id=v.service_visit_id AND (s.started_at IS NOT NULL OR s.status IN ('in_progress','completed'))) AS started_steps,
    EXISTS(SELECT 1 FROM mbt_bin_order_parts c JOIN mbt_bin_order_parts d ON d.visit_id=c.linked_delivery_visit_id
      WHERE d.visit_id=v.service_visit_id AND c.order_id<>d.order_id)
      OR EXISTS(SELECT 1 FROM mbt_transport_delivery_links l WHERE l.delivery_visit_id=v.service_visit_id AND l.released_at IS NULL) AS incoming_link
    FROM mbt_service_visits v WHERE v.service_visit_id=ANY($1::uuid[])`,[ids])).rows;
}
/** @param {any} root */
export async function workflowEditState(root) {
  const parts=/** @type {any[]} */ (await binWorkflowParts(String(root.service_visit_id)));
  const guards=/** @type {any[]} */ (await workflowEditGuards([root.service_visit_id,...parts.map(p=>p.visit_id)]));
  const enriched=parts.map(p=>({...p,...guards.find(g=>g.service_visit_id===p.visit_id)}));
  return {parts:enriched,permissions:workflowEditPermissions({...root,...guards.find(g=>g.service_visit_id===root.service_visit_id)},enriched)};
}
/** @param {any} destination */
function destinationKey(destination) {
  return destination?.kind==='yard' ? `yard:${destination.yardId || destination.location?.id}`
    : `delivery:${destination?.orderId || destination?.part || ''}`;
}
/** @param {any} root @param {any} input @param {any} state */
export function assertWorkflowEditFields(root,input,state) {
  const {permissions:p,parts}=state,configuration=root.configuration;
  if (!p.delivery && !p.collection) {throw binWorkflowError(409,p.reason);}
  assertSequenceFields(configuration,input,p.sequence);
  if (root.order_kind!=='collection' && !p.delivery) {assertDeliveryFields(input,parts);}
  if (root.order_kind!=='delivery' && !p.collection) {assertCollectionFields(configuration,input,parts);}
  const cargoRole=input.cargoRole || (root.order_kind==='collection'?'collection':'delivery');
  if (input.cargo!==undefined && !p[cargoRole]) {
    throw binWorkflowError(409,'The planned leg is locked. Use its cargo editor to change a planned cargo route.');
  }
}
/** @param {any} configuration @param {any} input @param {boolean} editable */
function assertSequenceFields(configuration,input,editable) {
  if (!editable && ((input.sequence!==undefined && input.sequence!==configuration.sequence)
      || (input.reuse!==undefined && input.reuse!==configuration.reuse))) {
    throw binWorkflowError(409,'The exchange sequence is locked while either leg is planned or started.');
  }
}
/** @param {any} input @param {any[]} parts */
function assertDeliveryFields(input,parts) {
  const delivery=parts.find(part=>part.part_role==='delivery');
  if (input.deliveryAssetId && input.deliveryAssetId!==delivery?.asset_id) {
    throw binWorkflowError(409,'The planned or linked delivery bin is locked.');
  }
}
/** @param {any} configuration @param {any} input @param {any[]} parts */
function assertCollectionFields(configuration,input,parts) {
  const collection=parts.find(p=>p.part_role==='collection');
  if ((input.dumpSiteId!==undefined && input.dumpSiteId!==configuration?.dumpSiteId)
      || (input.collectionAssetId && input.collectionAssetId!==collection?.asset_id)
      || collectionDestinationChanged(configuration,input)) {
    throw binWorkflowError(409,'The collection route is locked while the collection is planned or started.');
  }
}
/** @param {any} configuration @param {any} input */
function collectionDestinationChanged(configuration,input) {
  const same=configuration?.sequence==='collection_first' && configuration.reuse==='same_bin';
  if (same || !input.destination) {return false;}
  const destination=configuration?.parts.find((/** @type {any} */ p)=>p.role==='collection')?.destination;
  return destinationKey(input.destination)!==destinationKey(destination);
}
