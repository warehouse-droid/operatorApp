import {query,withTransaction} from './db.js';
import {getSalesStockRequest,recordStockRequestEvent} from './stock-request-repository.js';
import {regularApprovalExpired,regularError} from './regular-stock-domain.js';

export async function closeExpiredRegularStockRequest(id,input={},context={}) {
  const requestId=Number(id),revision=Number(input.expectedRevision);
  if(!Number.isSafeInteger(requestId)||requestId<=0||input.expectedRevision==null||!Number.isSafeInteger(revision)||revision<1)
    throw regularError('A valid request ID and revision are required.','REGULAR_STOCK_INVALID',400);
  return withTransaction(async()=>{
    // Share the request lock with SO handoff and re-raise. Check eligibility only
    // after acquiring it, so a stale page cannot close newly processing work.
    await query('SELECT id FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[requestId]);
    const request=await getSalesStockRequest(requestId,context);
    if(request.regular?.expiredClosedAt)return request;
    if(request.revision!==revision)throw regularError('This request changed. Reload and try again.','STOCK_REQUEST_REVISION_CONFLICT');
    const open=request.lines.filter(line=>!['closed','cancelled','rejected','received','fulfilled'].includes(line.status));
    if(request.workflowVersion!==2||!['pickup','delivery'].includes(request.regular?.deliveryMethod)
      ||request.regular.deliveryVersion===1||!regularApprovalExpired(request)
      ||!open.some(line=>line.status==='approved')||open.some(line=>!['approved','submitted','changes_requested'].includes(line.status))
      ||request.transfers?.length||(await query('SELECT 1 FROM regular_stock_handoffs WHERE request_id=$1',[requestId])).rowCount)
      throw regularError('Only an expired, unused approval can be closed.','REGULAR_CLOSE_NOT_ALLOWED');
    const closedAt=new Date().toISOString();
    await query(`UPDATE sales_stock_request_lines SET status='closed',updated_at=now()
      WHERE request_id=$1 AND status IN ('approved','submitted','changes_requested')`,[requestId]);
    await query(`UPDATE sales_stock_requests SET status='completed',revision=revision+1,updated_at=now(),
      regular_details=regular_details||$2::jsonb WHERE id=$1`,[requestId,JSON.stringify({expiredClosedAt:closedAt,expiredClosedBy:context.operatorId})]);
    await recordStockRequestEvent({requestId,eventType:'regular_expired_closed',actorId:context.operatorId,
      details:{previousApprovalExpiresAt:request.regular.approvalExpiresAt,previousRevision:revision,closedAt}});
    return getSalesStockRequest(requestId,context);
  });
}
