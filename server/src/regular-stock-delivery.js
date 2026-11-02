import {deliveryProgress} from './regular-stock-delivery-progress.js';
import {query,withTransaction} from './db.js';
import {deliveryRoute,deliveryMaterials,deliveryBaseYard,normalizeDeliveryLineSelection} from './regular-stock-delivery-domain.js';
import {regularError} from './regular-stock-domain.js';
import {groupStockRequestLinesForTransfer} from './stock-request-domain.js';
import {assertDeliveryStockRequestDestinationAccess} from './regular-stock-delivery-access.js';
import {createDeliveryStockRequestFromOrder,calculateDeliveryStockRequest,getScmStockRequest,getSalesStockRequest,recordStockRequestEvent} from './stock-request-repository.js';
import {refreshStockRequestItemsAvailability} from './stock-request-service.js';
import {readRegularStockSalesOrderFromNetSuite} from './netsuite.js';
import {linkRegularStockSalesOrder} from './regular-stock-handoff.js';
import {loadSalesOrderLineClaims,claimSalesOrderLines} from './regular-stock-line-claims.js';
import {assertDeliveryLinesUnclaimed,backorderedDeliveryLineIds} from './regular-stock-line-claim-domain.js';

function reference(value) {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (!ref || ref.length > 80 || /[\u0000-\u001f]/u.test(ref)) throw regularError('Enter a valid Sales Order number.', 'REGULAR_SO_REQUIRED', 400);
  return ref;
}

function requireDelivery(request) {
  if (request.regular?.deliveryVersion !== 1) throw regularError('This request does not use SO-based Delivery.', 'REGULAR_DELIVERY_REQUIRED');
}

/** Same requester, same route, SO-based Delivery: a resubmission of that request. */
function ownClaim(route, context) {
  return claim => claim.regular.deliveryVersion === 1 && claim.requestedBy === context.operatorId
    && Number(claim.regular.sourceLocationId) === route.sourceLocationId && claim.destinationLocationId === route.destinationLocationId;
}

/** A resubmission returns the request whose live line claims match it exactly.
 * Without a selection, it matches only when every backordered line is already covered. */
async function existingRequest(order, route, context, selection, claims) {
  const own = new Map();
  for (const claim of claims.filter(entry => entry.live && ownClaim(route,context)(entry))) {
    own.set(claim.requestId,[...(own.get(claim.requestId) || []),claim.remoteLineId]);
  }
  if (!own.size) return null;
  if (selection !== undefined) {
    const match = [...own].find(([,lineIds]) => lineIds.length === selection.length && selection.every(id => lineIds.includes(id)));
    return match ? getScmStockRequest(match[0]) : null;
  }
  const covered = new Set(claims.filter(claim => claim.live).map(claim => claim.remoteLineId));
  if (backorderedDeliveryLineIds(order,route.destinationLocationId).some(id => !covered.has(id))) return null;
  return getScmStockRequest(Math.max(...own.keys()));
}

/** Without an explicit selection, default to backordered lines no live claim covers. */
function defaultSelection(order, destination, selection, claims) {
  if (selection !== undefined) return selection;
  const covered = new Set(claims.filter(claim => claim.live).map(claim => claim.remoteLineId));
  const open = backorderedDeliveryLineIds(order,destination).filter(id => !covered.has(id));
  return open.length ? open : undefined;
}

async function saveRequest(order, route, materials, context) {
  return withTransaction(async () => {
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`regular-stock-so:${order.id}`]);
    const lineIds = materials.map(line=>line.remoteLineId);
    const claims = await loadSalesOrderLineClaims(order.id);
    const existing = await existingRequest(order,route,context,lineIds,claims);
    if (existing) return existing;
    assertDeliveryLinesUnclaimed(order,lineIds,claims,ownClaim(route,context));
    const request = await createDeliveryStockRequestFromOrder(route,materials,context);
    const approval = {automatic:route.automatic,rule:'delivery_yards',sourceName:route.sourceName,destinationName:route.destinationName};
    const details = {deliveryVersion:1,deliveryMethod:'delivery',sourceLocationId:route.sourceLocationId,sourceName:route.sourceName,
      salesOrderId:order.id,salesOrderRef:order.ref,customerId:order.customerId,approval,palletQuantity:request.deliveryCalculation.palletQuantity,
      selectedRemoteLineIds:lineIds,
      deliveryApproval:route.automatic ? 'approved' : 'pending',approvedAt:route.automatic ? new Date().toISOString() : null};
    await query(`UPDATE sales_stock_requests SET workflow_version=2,regular_details=$2::jsonb,status=$3,
      first_scm_decision_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE id=$1`,
    [request.id,JSON.stringify(details),route.automatic?'active':'submitted',route.automatic]);
    await query(`UPDATE sales_stock_request_lines SET status=$2,regular_decision=$3,decided_at=CASE WHEN $4 THEN now() ELSE NULL END
      WHERE request_id=$1`, [request.id,route.automatic?'approved':'submitted',route.automatic?'stock':null,route.automatic]);
    const plannedLines = request.lines.map(line => ({...line,decision:'stock'}));
    const plan = {delivery:true,mode:'transfer',sourceLocationId:null,groups:groupStockRequestLinesForTransfer(plannedLines),order,
      salesOrderId:order.id,salesOrderRef:order.ref,materialLineIds:lineIds,
      mappings:request.deliveryCalculation.lines.map((line,index)=>({requestLineId:request.lines[index].id,
        remoteLineId:line.remoteLineId,itemId:line.itemId,quantity:line.salesQty}))};
    await query(`INSERT INTO regular_stock_handoffs(request_id,sales_order_id,sales_order_ref,plan) VALUES($1,$2,$3,$4::jsonb)`,
      [request.id,order.id,order.ref,JSON.stringify(plan)]);
    const released = await claimSalesOrderLines(order.id,request.id,materials,claims);
    if (released.length) await recordStockRequestEvent({requestId:request.id,eventType:'regular_so_lines_reclaimed',actorId:context.operatorId,
      details:{salesOrderRef:order.ref,lines:released}});
    await recordStockRequestEvent({requestId:request.id,eventType:route.automatic?'regular_auto_approved':'regular_manual_review',actorId:context.operatorId,details:approval});
    return getScmStockRequest(request.id);
  });
}

export async function submitDeliveryStockRequest(input, context, dependencies = {}) {
  assertDeliveryStockRequestDestinationAccess(input.sourceLocationId,input.destinationLocationId,context.authorizedDestinationLocationIds);
  const route = deliveryRoute(input.sourceLocationId,input.destinationLocationId);
  const ref = reference(input.salesOrderRef);
  if (input.lines !== undefined) throw regularError('Delivery items and quantities come from the Sales Order.', 'REGULAR_DELIVERY_SO_ITEMS', 400);
  const selection = normalizeDeliveryLineSelection(input.selectedRemoteLineIds);
  await deliveryProgress('checking_so');
  const order = await (dependencies.readOrder || readRegularStockSalesOrderFromNetSuite)(ref);
  const claims = await loadSalesOrderLineClaims(order.id);
  const existing = await existingRequest(order,route,context,selection,claims);
  if (existing) return existing.regular.deliveryApproval === 'approved' ? retryDeliveryStockRequest(existing.id,context,dependencies) : existing;
  const materials = deliveryMaterials(order,route.destinationLocationId,defaultSelection(order,route.destinationLocationId,selection,claims));
  // Fail before the stock refresh; saveRequest repeats this under the SO lock.
  assertDeliveryLinesUnclaimed(order,materials.map(line=>line.remoteLineId),claims,ownClaim(route,context));
  await deliveryProgress('checking_stock');
  await (dependencies.refreshAvailability || refreshStockRequestItemsAvailability)(materials.map(line=>line.itemId));
  await deliveryProgress('calculating');
  const request = await saveRequest(order,route,materials,context);
  return request.regular.deliveryApproval === 'approved' ? retryDeliveryStockRequest(request.id,context,dependencies) : request;
}

export async function previewDeliveryStockRequest(input, context, dependencies = {}) {
  await deliveryProgress('checking_so');
  const order = await (dependencies.readOrder || readRegularStockSalesOrderFromNetSuite)(reference(input.salesOrderRef));
  const base = deliveryBaseYard(order);
  assertDeliveryStockRequestDestinationAccess(input.sourceLocationId,base.locationId,context.authorizedDestinationLocationIds,{preview:true});
  const candidates = deliveryMaterials(order,base.locationId);
  const claims = (await loadSalesOrderLineClaims(order.id)).filter(claim => claim.live);
  const covered = new Map(claims.map(claim => [claim.remoteLineId,claim]));
  // Lines a live claim covers are shown but not selected; an empty default is a valid "none".
  const selection = input.selectedRemoteLineIds !== undefined ? input.selectedRemoteLineIds
    : candidates.filter(line => !covered.has(line.remoteLineId)).map(line => line.remoteLineId);
  const noneSelected = Array.isArray(selection) && selection.length === 0;
  const materials = noneSelected ? [] : deliveryMaterials(order,base.locationId,selection);
  assertDeliveryLinesUnclaimed(order,materials.map(line=>line.remoteLineId),claims,()=>false);
  const result = {salesOrderRef:order.ref,baseLocationId:base.locationId,baseName:base.yardCode,
    candidates:candidates.map(line=>({remoteLineId:line.remoteLineId,itemId:line.itemId,itemName:line.itemName || String(line.itemId),
      quantity:line.quantity,backorderedQuantity:line.backorderedQuantity,uom:line.uom,
      ...(covered.has(line.remoteLineId) ? {coveredBy:{requestRef:covered.get(line.remoteLineId).requestRef,
        transfers:covered.get(line.remoteLineId).transfers.filter(transfer=>!['closed','cancelled','rejected'].includes(String(transfer.status)))}} : {})})),
    selectedRemoteLineIds:materials.map(line=>line.remoteLineId)};
  if (!input.sourceLocationId || [base.locationId,String(base.locationId)].includes(input.sourceLocationId)) return result;
  const route = deliveryRoute(input.sourceLocationId,base.locationId);
  if (noneSelected) return result;
  await deliveryProgress('checking_stock');
  await (dependencies.refreshAvailability || refreshStockRequestItemsAvailability)(materials.map(line=>line.itemId));
  await deliveryProgress('calculating');
  try {
    return {...result,...await calculateDeliveryStockRequest(route,materials)};
  } catch (error) {
    if (!['REGULAR_DELIVERY_STOCK_SHORTAGE','REGULAR_DELIVERY_PALLET_CONVERSION'].includes(error.code)) throw error;
    return {...result,calculationError:error.message,calculationCode:error.code};
  }
}

export async function retryDeliveryStockRequest(id, context, dependencies = {}) {
  await deliveryProgress('checking_request');
  const request = await getSalesStockRequest(id,context);
  requireDelivery(request);
  if (request.regular.deliveryApproval !== 'approved' || request.status === 'cancelled') {
    throw regularError('SCM approval is required before creating this Delivery transfer.', 'REGULAR_APPROVAL_REQUIRED');
  }
  try {
    return await linkRegularStockSalesOrder(id,{salesOrderRef:request.regular.salesOrderRef},context,dependencies);
  } catch (error) {
    // Return the saved request after a partial external failure, so Sales sees
    // its ID and a retry action rather than accidentally submitting a new case.
    const current = await getScmStockRequest(id);
    if (!['executing','attention','complete'].includes(current.regular.handoffStatus)) {
      await query(`UPDATE sales_stock_requests SET regular_details=regular_details||$2::jsonb,updated_at=now() WHERE id=$1`,
        [id,JSON.stringify({handoffStatus:'attention',handoffError:String(error.message).slice(0,2000)})]);
    }
    return getScmStockRequest(id);
  }
}

export async function decideDeliveryStockRequest(id, input, context, dependencies = {}) {
  await deliveryProgress('saving_approval');
  const request = await withTransaction(async () => {
    await query('SELECT id FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[id]);
    const current = await getScmStockRequest(id);
    requireDelivery(current);
    if (Number(input.expectedRevision) !== current.revision || current.status !== 'submitted'
        || current.regular.deliveryApproval !== 'pending' || current.lines.some(line => line.status !== 'submitted')) {
      throw regularError('This Delivery request changed. Reload before reviewing it.', 'STOCK_REQUEST_REVISION_CONFLICT');
    }
    if (!['stock','reject'].includes(input.decision)) throw regularError('Approve the Delivery transfer or reject the request.', 'REGULAR_DECISION_INVALID', 400);
    if (input.lineIds !== undefined && (!Array.isArray(input.lineIds) || new Set(input.lineIds.map(Number)).size !== current.lines.length
        || current.lines.some(line => !input.lineIds.map(Number).includes(line.id)))) {
      throw regularError('Review the entire Delivery request together.', 'REGULAR_DECISION_INVALID', 400);
    }
    const reason = String(input.reason || '').trim(), approved = input.decision === 'stock';
    if (reason.length > 1000 || !approved && !reason) throw regularError('Rejection requires a reason, at most 1000 characters.', 'REGULAR_REASON_REQUIRED', 400);
    await query(`UPDATE sales_stock_request_lines SET status=$2,regular_decision=$3,decision_reason=$4,decided_by=$5,decided_at=now()
      WHERE request_id=$1`, [id,approved?'approved':'rejected',input.decision,reason,context.operatorId]);
    const event = (await query(`INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details)
      VALUES($1,'regular_manual_decision',$2,$3::jsonb) RETURNING id`, [id,context.operatorId,JSON.stringify({decision:input.decision,reason,lineIds:current.lines.map(line=>line.id)})])).rows[0];
    await query(`UPDATE sales_stock_requests SET status=$2,revision=revision+1,first_scm_decision_at=now(),manual_decision_event_id=$3,
      regular_details=regular_details||$4::jsonb,updated_at=now() WHERE id=$1`, [id,approved?'active':'completed',event.id,
      JSON.stringify({deliveryApproval:approved?'approved':'rejected',approvedAt:approved?new Date().toISOString():null})]);
    return getScmStockRequest(id);
  });
  return request.regular.deliveryApproval === 'approved'
    ? retryDeliveryStockRequest(id,{...context,authorizedDestinationLocationIds:[request.destinationLocationId]},dependencies) : request;
}
