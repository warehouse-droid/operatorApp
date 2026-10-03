// @ts-check
import {query,withTransaction} from './db.js';
import {getScmStockRequest} from './stock-request-repository.js';
import {regularError} from './regular-stock-domain.js';
import {lockPurchaseStock} from './regular-stock-purchase-repository.js';

/** @param {{purchaseOrderRef?:unknown,eta?:unknown,expectedRevision?:unknown}} input */
export function normalizeRegularStockResolution(input={}) {
  const purchaseOrderRef=typeof input?.purchaseOrderRef==='string'?input.purchaseOrderRef.trim():'';
  const eta=typeof input?.eta==='string'?input.eta.trim():'';
  const expectedRevision=Number(input?.expectedRevision);
  if(!purchaseOrderRef||purchaseOrderRef.length>80||/[\u0000-\u001f\u007f]/u.test(purchaseOrderRef)) {
    throw regularError('Enter an existing PO number (at most 80 characters).','REGULAR_RESOLUTION_INVALID',400);
  }
  const instant=Date.parse(eta+'T00:00:00Z');
  const validDate=/^\d{4}-\d{2}-\d{2}$/.test(eta)&&Number.isFinite(instant)&&new Date(instant).toISOString().slice(0,10)===eta;
  if (!validDate) throw regularError('Enter a valid ETA date.','REGULAR_RESOLUTION_INVALID',400);
  if(!['string','number'].includes(typeof input?.expectedRevision)||!Number.isSafeInteger(expectedRevision)||expectedRevision<=0) {
    throw regularError('A valid request revision is required.','REGULAR_RESOLUTION_INVALID',400);
  }
  return {purchaseOrderRef,eta,expectedRevision};
}

/** @param {{id:number,workflowVersion:number,status:string,regular?:{deliveryMethod?:string,pickupTransfer?:unknown,handoffStatus?:string},lines:{status:string}[]}} request */
async function requireUncommitted(request) {
  const regular=request.regular||{},active=['submitted','changes_requested','approved'];
  const allowed=[...active,'rejected','cancelled','closed','received','fulfilled'];
  if(request.workflowVersion!==2||regular.deliveryMethod!=='stocking'||!['submitted','active'].includes(request.status)
    ||regular.pickupTransfer||regular.handoffStatus||!request.lines.some(line=>active.includes(line.status))
    ||request.lines.some(line=>!allowed.includes(line.status))) {
    throw regularError('Resolve is available for open Stocking requests before purchasing or TO creation starts.','REGULAR_RESOLUTION_LOCKED');
  }
  const commitments=await query(`SELECT 1 FROM regular_stock_handoffs WHERE request_id=$1
    UNION ALL SELECT 1 FROM sales_stock_transfers WHERE request_id=$1
    UNION ALL SELECT 1 FROM regular_stock_purchase_demands d JOIN sales_stock_request_lines l ON l.id=d.request_line_id WHERE l.request_id=$1 LIMIT 1`,[request.id]);
  if (commitments.rowCount) throw regularError('Purchasing or TO creation has already started. Finish the existing workflow before resolving.','REGULAR_RESOLUTION_LOCKED');
}

/** @param {string} reference */
async function existingPurchaseOrder(reference) {
  const result=await query('SELECT netsuite_id,tranid FROM purchase_orders WHERE UPPER(BTRIM(tranid))=UPPER($1) AND netsuite_active=true ORDER BY netsuite_id FOR SHARE',[reference]);
  if(!result.rowCount)throw regularError('PO not found. Enter an existing PO number from the local mirror.','REGULAR_RESOLUTION_PO_NOT_FOUND',404);
  if(result.rowCount!==1)throw regularError('This PO number matches more than one order. Resolve the duplicate PO reference first.','REGULAR_RESOLUTION_PO_AMBIGUOUS');
  return {purchaseOrderId:Number(result.rows[0].netsuite_id),purchaseOrderRef:result.rows[0].tranid.trim()};
}

/** @param {number|string} id @param {{purchaseOrderRef?:unknown,eta?:unknown,expectedRevision?:unknown}} input @param {{operatorId:string}} context */
export async function resolveRegularStockRequest(id,input,context) {
  const reply=normalizeRegularStockResolution(input),requestId=Number(id);
  if(!Number.isSafeInteger(requestId)||requestId<=0)throw regularError('A valid request ID is required.','REGULAR_RESOLUTION_INVALID',400);
  return withTransaction(async()=>{
    // Match the Purchase acceptance/release lock order before locking the case.
    await lockPurchaseStock();
    const row=(await query('SELECT * FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
    if(!row||row.request_type!=='regular')throw regularError('Regular Stocking request not found.','REGULAR_NOT_FOUND',404);
    const saved=row.regular_details?.resolution;
    if (saved) {
      if(saved.purchaseOrderRef.toUpperCase()!==reply.purchaseOrderRef.toUpperCase()||saved.eta!==reply.eta) {
        throw regularError('This request is already resolved. The saved PO and ETA cannot be replaced.','REGULAR_RESOLUTION_LOCKED');
      }
      return {request:await getScmStockRequest(requestId),changed:false};
    }
    if(Number(row.revision)!==reply.expectedRevision)throw regularError('This request changed. Reload and try again.','STOCK_REQUEST_REVISION_CONFLICT');
    const request=await getScmStockRequest(requestId);
    await requireUncommitted(request);
    const order=await existingPurchaseOrder(reply.purchaseOrderRef);
    const resolution={...order,eta:reply.eta,resolvedAt:new Date().toISOString(),resolvedBy:context.operatorId};
    const event=(await query(`INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details)
      VALUES($1,'regular_manual_decision',$2,$3::jsonb) RETURNING id`,[requestId,context.operatorId,JSON.stringify({decision:'resolve',...resolution})])).rows[0];
    await query(`UPDATE sales_stock_request_lines SET status='closed',regular_decision='po',decision_reason=$2,
      decided_by=$3,decided_at=now(),updated_at=now() WHERE request_id=$1 AND status IN ('submitted','changes_requested','approved')`,
      [requestId,`Resolved with ${order.purchaseOrderRef}; ETA ${reply.eta}.`,context.operatorId]);
    await query(`UPDATE sales_stock_requests SET status='completed',revision=revision+1,
      first_scm_decision_at=COALESCE(first_scm_decision_at,now()),manual_decision_event_id=$2,
      regular_details=regular_details||$3::jsonb,updated_at=now() WHERE id=$1`,[requestId,event.id,JSON.stringify({resolution})]);
    return {request:await getScmStockRequest(requestId),changed:true};
  });
}
