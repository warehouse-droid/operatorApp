import {createHash} from 'node:crypto';
import {query} from './db.js';
import {createSalesStockRequest,getScmStockRequest} from './stock-request-repository.js';
import {getWaitlistRequest,withWaitlistTransaction} from './regular-waitlist-repository.js';
import {findSpecialCustomer} from './special-stock-customer-directory.js';
import {waitlistId,waitlistKey,waitlistQuantity,waitlistError} from './regular-waitlist-domain.js';

async function assertMovable(request,line) {
  const regular=request.regular_details;
  if(request.request_type!=='regular'||request.workflow_version!==2||regular.deliveryMethod!=='stocking'
    ||!['submitted','active'].includes(request.status)||regular.resolution||regular.pickupTransfer||regular.handoffStatus
    ||!['submitted','changes_requested','approved'].includes(line.status)||line.regular_decision==='po') {
    throw waitlistError('Only an open, uncommitted Stocking line can move to the waitlist.','STOCKING_WAITLIST_LOCKED',409);
  }
  const commitment=await query(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM regular_stock_purchase_demands WHERE request_line_id=$1)
    OR EXISTS(SELECT 1 FROM regular_stock_replenishment_requests WHERE request_line_id=$1)
    OR EXISTS(SELECT 1 FROM sales_stock_transfer_lines WHERE request_line_id=$1)
    OR EXISTS(SELECT 1 FROM regular_stock_handoffs WHERE request_id=$2)
    OR EXISTS(SELECT 1 FROM regular_stock_so_line_owners WHERE request_id=$2)`,[line.id,request.id]);
  if(commitment.rowCount)throw waitlistError('This line is committed to PO/TO processing.','STOCKING_WAITLIST_LOCKED',409);
}

async function createLinkedWaitlist(request,line,customerId,actorId) {
  const customer=await findSpecialCustomer(customerId);
  if(!customer)throw waitlistError('Select an active existing customer.','WAITLIST_CUSTOMER_INVALID',409);
  const item=(await query('SELECT item_type,stock_unit FROM inventory_items WHERE item_id=$1 FOR SHARE',[line.item_id])).rows[0];
  if(!item?.stock_unit||(item.item_type&&item.item_type!=='InvtPart'))throw waitlistError('Select an ordinary inventory item.','WAITLIST_ITEM_INVALID',400);
  if(item.stock_unit.trim().toLowerCase()!==line.sales_uom.trim().toLowerCase())throw waitlistError('The item sales unit changed. Review this line before converting.','WAITLIST_ITEM_UNIT_CHANGED',409);
  const quantity=waitlistQuantity(line.sales_qty);
  if(quantity!==Number(line.sales_qty))throw waitlistError('The saved quantity cannot be represented exactly on the waitlist.','WAITLIST_QUANTITY_PRECISION',409);
  const child=await createSalesStockRequest({deliveryMethod:'waitlist',destinationLocationId:Number(request.destination_location_id),
    remarks:request.remarks||'',lines:[{itemId:Number(line.item_id),salesQty:quantity}]},
    {operatorId:request.requested_by,authorizedDestinationLocationIds:[Number(request.destination_location_id)]});
  const origin=Number(request.regular_details.requestingLocationId??request.destination_location_id);
  if(![1,28,15,26].includes(origin))throw waitlistError('The source Sales yard is invalid.','STOCKING_WAITLIST_INVALID',409);
  await query('INSERT INTO regular_waitlist_requests(request_id,request_line_id,customer_id) VALUES($1,$2,$3)',[child.id,child.lines[0].id,customerId]);
  await query('UPDATE sales_stock_requests SET workflow_version=2,regular_details=$2::jsonb WHERE id=$1',[child.id,JSON.stringify({
    deliveryMethod:'waitlist',stockingType:'waitlist',customerId,customerName:customer.name,
    stockingSource:{requestId:Number(request.id),requestRef:request.request_ref,lineId:Number(line.id),requestingLocationId:origin}})]);
  await query(`INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details) VALUES($1,'stocking_waitlist_created',$2,$3::jsonb)`,
    [child.id,actorId,JSON.stringify({sourceRequestId:Number(request.id),sourceLineId:Number(line.id)})]);
  return child;
}

export async function moveStockingLineToWaitlist(id,lineId,input,context) {
  const requestId=waitlistId(id),selectedLineId=waitlistId(lineId),customerId=waitlistId(input.customerId),key=waitlistKey(input.operationKey);
  const revision=waitlistId(input.expectedRevision,'request revision');
  if(!context.operatorId)throw waitlistError('An SCM operator is required.','WAITLIST_FORBIDDEN',403);
  const scope=`stocking-line:${requestId}:${selectedLineId}`;
  const fingerprint=createHash('sha256').update(JSON.stringify({actor:context.operatorId,requestId,lineId:selectedLineId,customerId,revision})).digest('hex');
  const result=await withWaitlistTransaction(async()=>{
    const previous=(await query('SELECT * FROM regular_waitlist_commands WHERE operation_key=$1',[key])).rows[0];
    if(previous){
      if(previous.scope!==scope||previous.fingerprint!==fingerprint)throw waitlistError('This command key was used for different details.','WAITLIST_IDEMPOTENCY_CONFLICT',409);
      return previous.result;
    }
    const request=(await query('SELECT * FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
    if(!request)throw waitlistError('Stocking request was not found.','WAITLIST_NOT_FOUND',404);
    if(Number(request.revision)!==revision)throw waitlistError('This request changed. Refresh before converting.','STOCK_REQUEST_REVISION_CONFLICT',409);
    const line=(await query('SELECT * FROM sales_stock_request_lines WHERE request_id=$1 AND id=$2 FOR UPDATE',[requestId,selectedLineId])).rows[0];
    if(!line)throw waitlistError('The line does not belong to this request.','WAITLIST_NOT_FOUND',404);
    await assertMovable(request,line);
    const child=await createLinkedWaitlist(request,line,customerId,context.operatorId);
    await query("UPDATE sales_stock_request_lines SET status='cancelled',decision_reason=$2,decided_by=$3,decided_at=now(),updated_at=now() WHERE id=$1",
      [line.id,`Moved to waitlist ${child.requestRef}.`,context.operatorId]);
    const details={decision:'waitlist',lineId:selectedLineId,waitlistRequestId:child.id,waitlistRequestRef:child.requestRef,
      message:`${line.item_name} moved to waitlist ${child.requestRef}.`,quantity:Number(line.sales_qty),salesUom:line.sales_uom};
    const event=(await query(`INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details)
      VALUES($1,'stocking_line_waitlisted',$2,$3::jsonb) RETURNING id`,[requestId,context.operatorId,JSON.stringify(details)])).rows[0];
    await query(`UPDATE sales_stock_requests SET revision=revision+1,updated_at=now(),first_scm_decision_at=COALESCE(first_scm_decision_at,now()),
      manual_decision_event_id=$2,regular_details=regular_details||'{"replyStatus":null}'::jsonb,
      status=CASE WHEN EXISTS(SELECT 1 FROM sales_stock_request_lines WHERE request_id=$1 AND status NOT IN ('rejected','cancelled','fulfilled','received','closed')) THEN 'active' ELSE 'completed' END WHERE id=$1`,[requestId,event.id]);
    const {clearStockingLineReplies}=await import('./regular-stock-line-actions.js');
    await clearStockingLineReplies(requestId,[selectedLineId]);
    const result={requestId,waitlistRequestId:child.id};
    await query('INSERT INTO regular_waitlist_commands(operation_key,scope,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)',[key,scope,fingerprint,JSON.stringify(result)]);
    return result;
  });
  return {request:await getScmStockRequest(result.requestId),waitlistRequest:await getWaitlistRequest(result.waitlistRequestId)};
}
