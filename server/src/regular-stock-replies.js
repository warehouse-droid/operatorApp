import {query,withTransaction} from './db.js';
import {getScmStockRequest,getSalesStockRequest} from './stock-request-repository.js';
import {normalizeStockingReply} from './regular-stock-reply-domain.js';
import {regularError} from './regular-stock-domain.js';
import {stockingActionLine,stockingLineState,refreshStockingReplyStatus} from './regular-stock-line-actions.js';

export async function replyRegularStockRequest(id,input,context) {
  const reply=normalizeStockingReply(input,context.audience),requestId=Number(id);
  if(!Number.isSafeInteger(requestId)||requestId<=0)throw regularError('A valid request ID is required.','REGULAR_REPLY_INVALID',400);
  return withTransaction(async()=>{
    const row=(await query('SELECT * FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
    if(!row||row.request_type!=='regular')throw regularError('Regular Stocking request not found.','REGULAR_NOT_FOUND',404);
    if(context.audience==='sales'){
      await getSalesStockRequest(requestId,context);
      if(row.requested_by!==context.operatorId)throw regularError('Only the Sales requester can reply.','REGULAR_REPLY_FORBIDDEN',403);
    }
    if(row.workflow_version!==2||row.regular_details?.deliveryMethod!=='stocking'||!['submitted','active'].includes(row.status)
      ||row.regular_details?.resolution||row.regular_details?.pickupTransfer?.status==='executing'||row.regular_details?.handoffStatus==='executing'){
      throw regularError('Reply is available for open Stocking requests.','REGULAR_REPLY_LOCKED');
    }
    const request=await getScmStockRequest(requestId);
    const line=stockingActionLine(/** @type {{lines:{id:number,status:string,itemName:string}[]}} */ (request),input.lineId,'REGULAR_REPLY_INVALID');
    if(['closed','rejected','cancelled','received','fulfilled'].includes(line.status)) {
      throw regularError('Reply is available for open material lines.','REGULAR_REPLY_LOCKED');
    }
    if(context.audience==='sales'&&!(await query("SELECT 1 FROM sales_stock_request_events WHERE request_id=$1 AND event_type='regular_scm_reply' AND (request_line_id=$2 OR request_line_id IS NULL AND (details->>'lineId'=$2::text OR NOT (details ? 'lineId'))) LIMIT 1",[requestId,line.id])).rowCount){
      throw regularError('SCM must send instructions before Sales replies.','REGULAR_REPLY_LOCKED');
    }
    if(Number(row.revision)!==reply.expectedRevision)throw regularError('This request changed. Refresh and review it before replying.','STOCK_REQUEST_REVISION_CONFLICT');
    const message={lineId:line.id,itemName:line.itemName,message:reply.message,eta:reply.eta,salesOrderRef:reply.salesOrderRef,audience:context.audience,repliedBy:context.operatorId,repliedAt:new Date().toISOString()};
    const replyStatus=context.audience==='scm'?'pending_update':'pending_scm';
    const stockingLines=stockingLineState(request,line.id,{reply:message,replyStatus});
    const event=(await query(`INSERT INTO sales_stock_request_events(request_id,request_line_id,event_type,actor_id,details)
      VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id`,[requestId,line.id,`regular_${context.audience}_reply`,context.operatorId,JSON.stringify(message)])).rows[0];
    await query(`UPDATE sales_stock_requests SET revision=revision+1,updated_at=now(),regular_details=regular_details||$2::jsonb,
      manual_decision_event_id=CASE WHEN $3 THEN $4 ELSE manual_decision_event_id END WHERE id=$1`,
      [requestId,JSON.stringify({stockingLines,...(request.lines.length===1?{reply:message}:{})}),context.audience==='scm',event.id]);
    await refreshStockingReplyStatus(requestId);
    return getScmStockRequest(requestId);
  });
}
