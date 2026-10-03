import { query, withTransaction } from './db.js';
import { createSalesStockRequest, updateSalesStockRequest, getScmStockRequest, getSalesStockRequest, recordStockRequestEvent, decideSalesStockRequestLines } from './stock-request-repository.js';
import { refreshStockRequestItemsAvailability, refreshPurchaseStockAvailability } from './stock-request-service.js';
import { normalizeRegularArrival, normalizeRegularLeadHours, normalizeRegularApprovalMinutes } from '../public/regular-stock-input.js';
import { evaluateRegularStockApproval, regularError, regularApprovalExpired, isRegularStockingRequest } from './regular-stock-domain.js';
import { assertStockRequestDestinationAccess } from './stock-request-domain.js';
import { findSpecialCustomer } from './special-stock-customer-directory.js';
import { normalizeStockingType, isPurchaseStocking } from './regular-stock-purchase-domain.js';
import { getPurchaseStockEvidence } from './regular-stock-purchase-repository.js';
import {isWaitlist,waitlistError} from './regular-waitlist-domain.js';

export async function regularStockPolicies(itemIds=[]) {
  const { loadSmartScmPlanningDemandStates } = await import('./smart-scm-planning-repository.js');
  const planning = await loadSmartScmPlanningDemandStates({ includeTemporarilyExcluded: true,includePausedItemIds:itemIds });
  return planning.states.map(state => ({ itemId: Number(state.policy.item_id), sourceLocationId: Number(state.policy.location_id),
    availableQuantity: state.inventorySyncedAt ? (state.rawAvailableSales ?? state.availableSales) - (state.reservedOutboundSales || 0) : null,
    safetyQuantity: state.toPlt > 0 ? state.safety * state.toPlt : null }));
}

function requiredId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw regularError('A valid record ID is required.', 'REGULAR_STOCK_INVALID', 400);
  return id;
}

async function lockRequest(id, expectedRevision) {
  const result = await query('SELECT * FROM sales_stock_requests WHERE id=$1 FOR UPDATE', [requiredId(id)]);
  const row = result.rows[0];
  if (!row || row.request_type !== 'regular') throw regularError('Regular stock request not found.', 'REGULAR_NOT_FOUND', 404);
  if (expectedRevision !== undefined && (!Number.isSafeInteger(Number(expectedRevision)) || Number(row.revision) !== Number(expectedRevision))) {
    throw regularError('This request changed. Reload and try again.', 'STOCK_REQUEST_REVISION_CONFLICT');
  }
  return row;
}

async function inputDetails(input) {
  const deliveryMethod = String(input.deliveryMethod || '').toLowerCase();
  if (!['pickup', 'delivery', 'stocking'].includes(deliveryMethod)) throw regularError('Select Pickup, Delivery or Stocking.', 'REGULAR_DELIVERY_REQUIRED', 400);
  const arrival = deliveryMethod === 'delivery' ? normalizeRegularArrival(input.arrivalDate, input.arrivalTime)
    : {date:null,time:null,arrivalAt:null,timeZone:'America/Toronto'};
  let customerId = null;
  let customerName = String(input.customerName || '').trim();
  if (customerName.length > 200 || /[\u0000-\u001f]/u.test(customerName)) throw regularError('Customer name must be at most 200 characters.', 'REGULAR_CUSTOMER_INVALID', 400);
  if (input.customerId) {
    const customer = await findSpecialCustomer(requiredId(input.customerId));
    if (!customer) throw regularError('Select an active customer.', 'REGULAR_CUSTOMER_INVALID', 400);
    customerId = customer.id; customerName = customer.name;
  }
  return { customerId, customerName, deliveryMethod, stockingType: normalizeStockingType(deliveryMethod,input.stockingType), arrivalDate: arrival.date, arrivalTime: arrival.time, arrivalAt: arrival.arrivalAt, timeZone: arrival.timeZone };
}

async function collectEvidence(itemIds, dependencies) {
  try {
    await (dependencies.refreshAvailability || refreshStockRequestItemsAvailability)([...new Set(itemIds.map(Number))]);
    return { policies: await (dependencies.loadPolicies || regularStockPolicies)(itemIds), error: null };
  } catch (error) {
    return { policies: [], error: String(error.message).slice(0, 1000) };
  }
}

function approvalWindow(now,minutes) {
  const approvedAt=new Date(now).toISOString();
  return {approvedAt,approvalValidityMinutes:minutes,approvalExpiresAt:new Date(new Date(now).getTime()+minutes*60000).toISOString()};
}

async function purchaseEvidence(input, dependencies) {
  const stocks={}; let error=null;
  for (const id of [...new Set((input.lines||[]).map(line=>Number(line.itemId)))]) {
    try { stocks[id]=await (dependencies.loadPurchaseStock||getPurchaseStockEvidence)(id,Number(input.destinationLocationId)); }
    catch (failure) {stocks[id]={onHand:null,available:null,preferredStock:null};error=String(failure.message).slice(0,1000);}
  }
  return {stocks,error,policies:[]};
}

async function persistApproval(request, details, evidence, now) {
  const setting = await query('SELECT regular_stock_lead_hours,regular_stock_auto_approval_enabled,regular_stock_approval_minutes FROM scm_smart_settings WHERE id=1');
  const leadHours = normalizeRegularLeadHours(setting.rows[0]?.regular_stock_lead_hours ?? 5);
  const autoApprovalEnabled=setting.rows[0]?.regular_stock_auto_approval_enabled ?? true;
  const minutes=normalizeRegularApprovalMinutes(setting.rows[0]?.regular_stock_approval_minutes ?? 15);
  const approval = details.stockingType === 'purchase'
    ? {automatic:false,deliveryMethod:'stocking',leadTimeApplies:false,autoApprovalEnabled,evaluatedAt:new Date(now).toISOString(),lines:request.lines.map(line=>({lineId:line.id,...evidence.stocks?.[line.itemId],unit:line.salesUom,reasons:['purchase_scm_review']}))}
    : evaluateRegularStockApproval({ lines: request.lines, policies: evidence.policies, arrivalAt: details.arrivalAt, deliveryMethod: details.deliveryMethod, leadHours, autoApprovalEnabled, now });
  const window=approval.automatic?approvalWindow(now,minutes):{approvedAt:null,approvalValidityMinutes:minutes,approvalExpiresAt:null};
  await query(`UPDATE sales_stock_requests SET workflow_version=2,regular_details=$2::jsonb,
    status=$3,first_scm_decision_at=CASE WHEN $4 THEN now() ELSE first_scm_decision_at END WHERE id=$1`,
  [request.id, JSON.stringify({ ...details, approval, ...window, evidenceError: evidence.error }), approval.automatic ? 'active' : 'submitted', approval.automatic]);
  for (const line of approval.lines) {
    await query(`UPDATE sales_stock_request_lines SET approval_evidence=$2::jsonb,status=$3,
      regular_decision=$4,decided_by=NULL,decision_reason=NULL,decided_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1`,
    [line.lineId, JSON.stringify(line), approval.automatic ? 'approved' : 'submitted', approval.automatic ? 'stock' : null, approval.automatic]);
  }
  await recordStockRequestEvent({ requestId: request.id, eventType: approval.automatic ? 'regular_auto_approved' : 'regular_manual_review', details: approval });
  return getScmStockRequest(request.id);
}

export async function submitRegularStockRequest(input, context, dependencies = {}) {
  if(input.deliveryMethod==='waitlist'){
    const {submitWaitlistRequest}=await import('./regular-waitlist-repository.js');
    return submitWaitlistRequest(input,context);
  }
  assertStockRequestDestinationAccess(input.destinationLocationId, context.authorizedDestinationLocationIds);
  const details = await inputDetails(input);
  const evidence = details.stockingType === 'purchase' ? await purchaseEvidence(input,dependencies) : await collectEvidence((input.lines || []).map(line => line.itemId), dependencies);
  const now = (dependencies.now || (() => new Date()))();
  return withTransaction(async () => {
    const request = await createSalesStockRequest({...input,deliveryMethod:details.deliveryMethod,stockingType:details.stockingType}, context);
    return persistApproval(request, details, evidence, now);
  });
}

export async function editRegularStockRequest(id, input, context, dependencies = {}) {
  const before = await getSalesStockRequest(id, context);
  if(isWaitlist(before))throw waitlistError('Close the waitlist request and submit corrected details.','WAITLIST_WORKFLOW_ONLY',409);
  if(before.regular?.deliveryVersion===1)throw regularError('Delivery items and routing are saved from the SO. Cancel a pending request to start again.','REGULAR_DELIVERY_LOCKED');
  if (before.workflowVersion !== 2) return updateSalesStockRequest(id, input, context);
  const details = await inputDetails({...input,stockingType:input.stockingType??before.regular.stockingType});
  const evidence = details.stockingType === 'purchase' ? await purchaseEvidence({...input,destinationLocationId:input.destinationLocationId??before.destinationLocationId},dependencies) : await collectEvidence((input.lines || []).map(line => line.itemId), dependencies);
  return withTransaction(async () => {
    const request = await updateSalesStockRequest(id, {...input,stockingType:details.stockingType}, context);
    return persistApproval(request, details, evidence, (dependencies.now || (() => new Date()))());
  });
}

export async function reraiseRegularStockRequest(id,input,context,dependencies={}) {
  const before=await getSalesStockRequest(id,context);
  const now=()=> (dependencies.now || (()=>new Date()))();
  const eligible=request=>request.workflowVersion===2 && regularApprovalExpired(request,now());
  if(!eligible(before))throw regularError('Only an expired, unused approval can be re-raised.');
  if(input.expectedRevision===undefined)throw regularError('Request revision is required.');
  const details=await inputDetails(before.regular);
  const targets=before.lines.filter(line=>line.status==='approved');
  if(!targets.length)throw regularError('No expired approved items can be re-raised.');
  const evidence=await collectEvidence(targets.map(line=>line.itemId),dependencies);
  return withTransaction(async()=>{
    await lockRequest(id,input.expectedRevision);
    const request=await getScmStockRequest(id);
    if(!eligible(request)||(await query('SELECT 1 FROM regular_stock_handoffs WHERE request_id=$1',[id])).rowCount)throw regularError('This request is already being processed or no longer has an expired approval.');
    await query('UPDATE sales_stock_requests SET revision=revision+1,manual_decision_event_id=0,updated_at=now() WHERE id=$1',[id]);
    await recordStockRequestEvent({requestId:Number(id),eventType:'regular_approval_reraised',actorId:context.operatorId,
      details:{previousApprovalExpiresAt:request.regular.approvalExpiresAt,previousApproval:request.regular.approval}});
    return persistApproval({...request,lines:request.lines.filter(line=>line.status==='approved')},details,evidence,now());
  });
}

export async function refreshRegularStockEvidence(id, dependencies = {}) {
  const request = await getScmStockRequest(id);
  if(isWaitlist(request))return request;
  if (isPurchaseStocking(request)) {
    const evidence=await purchaseEvidence({destinationLocationId:request.destinationLocationId,lines:request.lines},{...dependencies,
      loadPurchaseStock:dependencies.loadPurchaseStock||(async(itemId,locationId)=>{
        await (dependencies.refreshPurchaseAvailability||refreshPurchaseStockAvailability)(itemId,locationId,dependencies);
        return getPurchaseStockEvidence(itemId,locationId);
      })});
    return {...request,currentEvidence:request.lines.map(line=>({lineId:line.id,...evidence.stocks[line.itemId],unit:line.salesUom})),evidenceError:evidence.error};
  }
  if(request.regular?.deliveryVersion===1)return request;
  if (request.workflowVersion !== 2) return request;
  if(request.regular.pickupTransfer || request.regular.handoffStatus==='complete' || request.status==='completed')return request;
  const evidence = await collectEvidence(request.lines.map(line => line.itemId), dependencies);
  const current = evaluateRegularStockApproval({ lines: request.lines, policies: evidence.policies, arrivalAt: request.regular.arrivalAt,
    deliveryMethod: request.regular.deliveryMethod, leadHours: request.regular.approval.leadHours, autoApprovalEnabled:request.regular.approval.autoApprovalEnabled, now: request.regular.approval.evaluatedAt });
  // Current review evidence is separate from the immutable approval snapshot.
  return { ...request, currentEvidence: current.lines, evidenceError: evidence.error };
}

export async function decideRegularStockRequest(id, input, context, dependencies = {}) {
  const before = await getScmStockRequest(id);
  if(isWaitlist(before))throw waitlistError('Use the Waitlist allocation workspace.','WAITLIST_WORKFLOW_ONLY',409);
  if(before.regular?.deliveryVersion===1){
    const {decideDeliveryStockRequest}=await import('./regular-stock-delivery.js');
    return decideDeliveryStockRequest(id,input,context,dependencies);
  }
  if (before.workflowVersion !== 2) return decideSalesStockRequestLines(id, input, context);
  const decision = String(input.decision || '');
  if(isPurchaseStocking(before)&&decision!=='reject')throw regularError('Use Add to PO/TO proposal after reviewing Purchase quantities.');
  if(isRegularStockingRequest(before) && decision!=='reject')throw regularError('Use Convert to TO to approve and transfer a Stocking request.','REGULAR_PICKUP_SCM_REQUIRED');
  if (!['stock', 'po', 'reject'].includes(decision)) throw regularError('Choose TO/location change, PO replenishment, or Reject.', 'REGULAR_DECISION_INVALID', 400);
  const reason = String(input.reason || '').trim();
  if (reason.length > 1000 || decision === 'reject' && !reason) throw regularError('Rejection requires a reason, at most 1000 characters.', 'REGULAR_REASON_REQUIRED', 400);
  const lineIds = [...new Set((input.lineIds || []).map(requiredId))];
  if (!lineIds.length) throw regularError('Select at least one item.', 'REGULAR_DECISION_INVALID', 400);
  const evidence = isPurchaseStocking(before) ? await purchaseEvidence({destinationLocationId:before.destinationLocationId,lines:before.lines},dependencies) : await collectEvidence(before.lines.map(line => line.itemId), dependencies);
  return withTransaction(async () => {
    const row = await lockRequest(id, input.expectedRevision);
    const request = await getScmStockRequest(id);
    if (input.expectedRevision === undefined) throw regularError('Request revision is required.');
    const selected = request.lines.filter(line => lineIds.includes(line.id));
    const pendingStocking=isRegularStockingRequest(request) && !isPurchaseStocking(request) && !request.regular.pickupTransfer && !request.regular.handoffStatus;
    if (selected.length !== lineIds.length || selected.some(line => line.status !== 'submitted' && !(pendingStocking && decision==='reject' && line.status==='approved'))) throw regularError('Only undecided lines can be reviewed.');
    const snapshot = isPurchaseStocking(request) ? {...request.regular.approval,lines:request.lines.map(line=>({lineId:line.id,...evidence.stocks[line.itemId],unit:line.salesUom,reasons:['purchase_scm_review']}))}
      : evaluateRegularStockApproval({ lines: request.lines, policies: evidence.policies, arrivalAt: request.regular.arrivalAt,
      deliveryMethod: request.regular.deliveryMethod, leadHours: request.regular.approval.leadHours, now: (dependencies.now || (() => new Date()))() });
    for (const line of selected) await query(`UPDATE sales_stock_request_lines SET regular_decision=$2,status=$3,
      decision_reason=$4,decided_by=$5,decided_at=now(),approval_evidence=$6::jsonb,updated_at=now() WHERE id=$1`,
    [line.id, decision, decision === 'reject' ? 'rejected' : 'approved', reason, context.operatorId,
      JSON.stringify(snapshot.lines.find(entry => entry.lineId === line.id))]);
    const updated=await getScmStockRequest(id);
    const minutes=normalizeRegularApprovalMinutes((await query('SELECT regular_stock_approval_minutes FROM scm_smart_settings WHERE id=1')).rows[0].regular_stock_approval_minutes);
    const window=!isRegularStockingRequest(updated) && updated.lines.some(line=>line.status==='approved') && updated.lines.every(line=>['approved','rejected','cancelled'].includes(line.status))
      ? approvalWindow((dependencies.now || (()=>new Date()))(),minutes) : {approvedAt:null,approvalExpiresAt:null,approvalValidityMinutes:minutes};
    const event = await query(`INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details)
      VALUES($1,'regular_manual_decision',$2,$3::jsonb) RETURNING id`, [id, context.operatorId, JSON.stringify({ decision, lineIds, reason, evidence: snapshot, evidenceError: evidence.error })]);
    await query(`UPDATE sales_stock_requests SET revision=revision+1,first_scm_decision_at=COALESCE(first_scm_decision_at,now()),
      manual_decision_event_id=$2,status=CASE WHEN EXISTS(SELECT 1 FROM sales_stock_request_lines WHERE request_id=$1 AND status NOT IN ('rejected','cancelled','fulfilled','received','closed')) THEN 'active' ELSE 'completed' END,
      regular_details=regular_details||$3::jsonb,updated_at=now() WHERE id=$1`, [row.id,event.rows[0].id,JSON.stringify(window)]);
    return getScmStockRequest(id);
  });
}

export async function regularStockAlerts({ scm = false, operatorId, authorizedDestinationLocationIds = [] } = {}) {
  if (scm) {
    const { rows } = await query(`SELECT count(*)::int AS count FROM sales_stock_requests r WHERE r.workflow_version=2 AND r.request_type='regular'
      AND COALESCE(r.regular_details->>'deliveryMethod','')<>'waitlist'
      AND EXISTS(SELECT 1 FROM sales_stock_request_lines l WHERE l.request_id=r.id AND (l.status='submitted'
        OR (l.status='approved' AND r.regular_details->>'deliveryMethod'='stocking'
          AND COALESCE(r.regular_details->>'stockingType','transfer')<>'purchase'
          AND NOT r.regular_details ? 'pickupTransfer' AND NOT r.regular_details ? 'handoffStatus')))`);
    const returned=(await query(`SELECT p.id,COALESCE(NULLIF(o.dispatch_ref,''),o.tranid) AS po_ref,i.item_name
      FROM regular_waitlist_pools p JOIN purchase_orders o ON o.netsuite_id=p.purchase_order_id JOIN inventory_items i ON i.item_id=p.item_id
      LEFT JOIN regular_waitlist_pool_reads seen ON seen.pool_id=p.id AND seen.operator_id=$1
      WHERE p.last_return_event_id>COALESCE(seen.event_id,0) ORDER BY p.last_return_event_id DESC LIMIT 200`,[operatorId||null])).rows;
    return { manualReview: rows[0].count, returnedPools:returned.map(p=>({id:Number(p.id),purchaseOrderRef:p.po_ref,itemCode:p.item_name})),total:rows[0].count+returned.length };
  }
  if (!operatorId || !authorizedDestinationLocationIds.length) return { unread: 0, total: 0, requests: [] };
  const { rows } = await query(`SELECT r.id,r.request_ref,r.manual_decision_event_id FROM sales_stock_requests r
    LEFT JOIN regular_stock_decision_reads seen ON seen.request_id=r.id AND seen.operator_id=$1
    WHERE r.workflow_version=2 AND r.request_type='regular' AND r.requested_by=$1 AND r.destination_location_id=ANY($2::bigint[])
      AND r.manual_decision_event_id>COALESCE(seen.event_id,0) ORDER BY r.manual_decision_event_id DESC`,[operatorId,authorizedDestinationLocationIds]);
  return { unread: rows.length, total: rows.length, requests: rows.map(row => ({ id: Number(row.id), requestRef: row.request_ref, eventId: Number(row.manual_decision_event_id) })) };
}

export async function acknowledgeRegularStockDecisions(id, { eventId }, context) {
  return withTransaction(async () => {
    const request = await lockRequest(id);
    await getSalesStockRequest(id, context);
    if (request.requested_by !== context.operatorId) throw regularError('Only the requester can acknowledge this decision.', 'REGULAR_ALERT_FORBIDDEN', 403);
    const event = requiredId(eventId);
    const found = await query(`SELECT id FROM sales_stock_request_events WHERE id=$1 AND request_id=$2 AND event_type IN
      ('regular_manual_decision','waitlist_allocation_confirmed','waitlist_allocation_released','waitlist_allocation_expired','waitlist_rejected')`,[event,id]);
    if (!found.rowCount || event > Number(request.manual_decision_event_id)) throw regularError('That decision was not displayed for this request.');
    await query(`INSERT INTO regular_stock_decision_reads(request_id,operator_id,event_id) VALUES($1,$2,$3)
      ON CONFLICT(request_id,operator_id) DO UPDATE SET event_id=GREATEST(regular_stock_decision_reads.event_id,EXCLUDED.event_id),read_at=now()`,[id,context.operatorId,event]);
    return { acknowledged: true, eventId: event };
  });
}
