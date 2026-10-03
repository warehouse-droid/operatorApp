import {deliveryProgress} from './regular-stock-delivery-progress.js';
import {query,withTransaction} from './db.js';
import {deliveryRoute,deliveryMaterials,deliveryBaseYard} from './regular-stock-delivery-domain.js';
import {regularError} from './regular-stock-domain.js';
import {assertStockRequestDestinationAccess,groupStockRequestLinesForTransfer} from './stock-request-domain.js';
import {createDeliveryStockRequestFromOrder,calculateDeliveryStockRequest,getScmStockRequest,getSalesStockRequest,recordStockRequestEvent} from './stock-request-repository.js';
import {refreshStockRequestItemsAvailability} from './stock-request-service.js';
import {readRegularStockSalesOrderFromNetSuite} from './netsuite.js';
import {linkRegularStockSalesOrder} from './regular-stock-handoff.js';

function reference(value) {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (!ref || ref.length > 80 || /[\u0000-\u001f]/u.test(ref)) throw regularError('Enter a valid Sales Order number.', 'REGULAR_SO_REQUIRED', 400);
  return ref;
}

function requireDelivery(request) {
  if (request.regular?.deliveryVersion !== 1) throw regularError('This request does not use SO-based Delivery.', 'REGULAR_DELIVERY_REQUIRED');
}

async function existingRequest(order, route, context) {
  const existing = (await query(`SELECT h.request_id FROM regular_stock_handoffs h
    WHERE h.sales_order_id=$1 OR upper(btrim(h.sales_order_ref))=upper(btrim($2))`, [order.id,order.ref])).rows[0];
  if (!existing) return null;
  const request = await getScmStockRequest(existing.request_id);
  if (request.regular.deliveryVersion !== 1 || request.requestedBy !== context.operatorId
      || request.regular.sourceLocationId !== route.sourceLocationId || request.destinationLocationId !== route.destinationLocationId) {
    throw regularError('This SO is already linked to another stock request.', 'REGULAR_SO_REUSED');
  }
  return request;
}

async function saveRequest(order, route, materials, context) {
  return withTransaction(async () => {
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`regular-stock-so:${order.id}`]);
    const existing = await existingRequest(order,route,context);
    if (existing) return existing;
    const request = await createDeliveryStockRequestFromOrder(route,materials,context);
    const approval = {automatic:route.automatic,rule:'delivery_yards',sourceName:route.sourceName,destinationName:route.destinationName};
    const details = {deliveryVersion:1,deliveryMethod:'delivery',sourceLocationId:route.sourceLocationId,sourceName:route.sourceName,
      salesOrderId:order.id,salesOrderRef:order.ref,customerId:order.customerId,approval,palletQuantity:request.deliveryCalculation.palletQuantity,
      deliveryApproval:route.automatic ? 'approved' : 'pending',approvedAt:route.automatic ? new Date().toISOString() : null};
    await query(`UPDATE sales_stock_requests SET workflow_version=2,regular_details=$2::jsonb,status=$3,
      first_scm_decision_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE id=$1`,
    [request.id,JSON.stringify(details),route.automatic?'active':'submitted',route.automatic]);
    await query(`UPDATE sales_stock_request_lines SET status=$2,regular_decision=$3,decided_at=CASE WHEN $4 THEN now() ELSE NULL END
      WHERE request_id=$1`, [request.id,route.automatic?'approved':'submitted',route.automatic?'stock':null,route.automatic]);
    const plannedLines = request.lines.map(line => ({...line,decision:'stock'}));
    const plan = {delivery:true,mode:'transfer',sourceLocationId:null,groups:groupStockRequestLinesForTransfer(plannedLines),order,
      salesOrderId:order.id,salesOrderRef:order.ref,materialLineIds:materials.map(line=>line.remoteLineId),
      mappings:request.deliveryCalculation.lines.map((line,index)=>({requestLineId:request.lines[index].id,
        remoteLineId:line.remoteLineId,itemId:line.itemId,quantity:line.salesQty}))};
    await query(`INSERT INTO regular_stock_handoffs(request_id,sales_order_id,sales_order_ref,plan) VALUES($1,$2,$3,$4::jsonb)`,
      [request.id,order.id,order.ref,JSON.stringify(plan)]);
    for (const line of materials) await query(`INSERT INTO regular_stock_so_line_owners(sales_order_id,remote_line_id,request_id) VALUES($1,$2,$3)`,
      [order.id,line.remoteLineId,request.id]);
    await recordStockRequestEvent({requestId:request.id,eventType:route.automatic?'regular_auto_approved':'regular_manual_review',actorId:context.operatorId,details:approval});
    return getScmStockRequest(request.id);
  });
}

export async function submitDeliveryStockRequest(input, context, dependencies = {}) {
  assertStockRequestDestinationAccess(input.destinationLocationId,context.authorizedDestinationLocationIds);
  const route = deliveryRoute(input.sourceLocationId,input.destinationLocationId);
  const ref = reference(input.salesOrderRef);
  if (input.lines !== undefined) throw regularError('Delivery items and quantities come from the Sales Order.', 'REGULAR_DELIVERY_SO_ITEMS', 400);
  await deliveryProgress('checking_so');
  const order = await (dependencies.readOrder || readRegularStockSalesOrderFromNetSuite)(ref);
  const existing = await existingRequest(order,route,context);
  if (existing) return existing.regular.deliveryApproval === 'approved' ? retryDeliveryStockRequest(existing.id,context,dependencies) : existing;
  const materials = deliveryMaterials(order,route.destinationLocationId);
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
  assertStockRequestDestinationAccess(base.locationId,context.authorizedDestinationLocationIds);
  const materials = deliveryMaterials(order,base.locationId);
  const result = {salesOrderRef:order.ref,baseLocationId:base.locationId,baseName:base.yardCode};
  if (!input.sourceLocationId || [base.locationId,String(base.locationId)].includes(input.sourceLocationId)) return result;
  const route = deliveryRoute(input.sourceLocationId,base.locationId);
  await deliveryProgress('checking_stock');
  await (dependencies.refreshAvailability || refreshStockRequestItemsAvailability)(materials.map(line=>line.itemId));
  await deliveryProgress('calculating');
  return {...result,...await calculateDeliveryStockRequest(route,materials)};
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
