import {createHash,randomUUID} from 'node:crypto';
import {query,withTransaction} from './db.js';
import {createSalesStockRequest,getScmStockRequest} from './stock-request-repository.js';
import {assertStockRequestDestinationAccess} from './stock-request-domain.js';
import {findSpecialCustomer} from './special-stock-customer-directory.js';
import {isWaitlist,waitlistError,waitlistQuantity,waitlistId,waitlistText,waitlistKey,roundWaitlistQuantity,
  waitlistTotals,waitlistPoolBalance,rankWaitlistRequests,assertWaitlistSelectionPriority,
  waitlistReleaseEligibility,normalizeWaitlistFulfillment,WAITLIST_AUTO_RELEASE_MS} from './regular-waitlist-domain.js';
import {resolveWaitlistPo,waitlistPoolSupply,normalizedWaitlistUnit,recentQueuedWaitlistPurchaseOrders} from './regular-waitlist-supply.js';

const iso=value=>value?new Date(value).toISOString():null;
const activeConversions="('pending','preparing','submitted','uncertain')";

// All local ledger writes share a short transaction. No network calls run here.
export function withWaitlistTransaction(callback){
  return withTransaction(async()=>{
    await query("SELECT pg_advisory_xact_lock(hashtextextended('regular-waitlist-ledger',0))");
    return callback();
  });
}
function assertRevision(row,expected){
  if(!Number.isSafeInteger(Number(expected)) || Number(expected)!==Number(row.revision))
    throw waitlistError('This record changed. Refresh before confirming.','STOCK_REQUEST_REVISION_CONFLICT',409);
}
async function requestRow(id,context){
  const row=(await query(`SELECT r.*,w.request_line_id,w.customer_id,w.closed_at,l.item_id,l.sales_qty,l.sales_uom
    FROM regular_waitlist_requests w JOIN sales_stock_requests r ON r.id=w.request_id
    JOIN sales_stock_request_lines l ON l.id=w.request_line_id WHERE r.id=$1 FOR UPDATE OF r,w`,[id])).rows[0];
  if(!row)throw waitlistError('Waitlist request was not found.','WAITLIST_NOT_FOUND',404);
  if(context)assertStockRequestDestinationAccess(row.destination_location_id,context.authorizedDestinationLocationIds);
  return row;
}
async function assertNotConverting(id){
  if((await query(`SELECT 1 FROM regular_waitlist_conversions WHERE request_id=$1 AND status IN ${activeConversions}`,[id])).rowCount)
    throw waitlistError('SO creation is in progress. Its allocation remains held until the outcome is known.','WAITLIST_CONVERSION_BUSY',409);
}
async function command(scope,input,context,callback){
  const key=waitlistKey(input.operationKey);
  const fingerprint=createHash('sha256').update(JSON.stringify({actor:context.operatorId,input})).digest('hex');
  const previous=(await query('SELECT * FROM regular_waitlist_commands WHERE operation_key=$1',[key])).rows[0];
  if(previous){
    if(previous.scope!==scope || previous.fingerprint!==fingerprint)throw waitlistError('This command key was already used for different details.','WAITLIST_IDEMPOTENCY_CONFLICT',409);
    return previous.result;
  }
  const result=await callback();
  await query('INSERT INTO regular_waitlist_commands(operation_key,scope,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)',[key,scope,fingerprint,JSON.stringify(result)]);
  return result;
}
async function notice(id,type,actor,details,{notify=true}={}){
  const event=(await query(`INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details)
    VALUES($1,$2,$3,$4::jsonb) RETURNING id`,[id,type,actor||null,JSON.stringify(details)])).rows[0];
  await query(`UPDATE sales_stock_requests SET revision=revision+1,updated_at=now(),
    manual_decision_event_id=CASE WHEN $2 THEN $3 ELSE manual_decision_event_id END WHERE id=$1`,[id,notify,event.id]);
  return Number(event.id);
}
async function touchPools(ids){
  if(ids.length)await query('UPDATE regular_waitlist_pools SET revision=revision+1,updated_at=now() WHERE id=ANY($1::bigint[])',[[...new Set(ids)]]);
}
async function refreshRequestStatus(id){
  const row=await requestRow(id);
  const totals=(await query(`SELECT COALESCE(SUM(quantity) FILTER(WHERE status IN ('reserved','converting')),0) AS held,
    COALESCE(SUM(quantity) FILTER(WHERE status='committed'),0) AS converted FROM regular_waitlist_allocations WHERE request_id=$1`,[id])).rows[0];
  const closed=Boolean(row.closed_at),complete=Number(totals.converted)>=Number(row.sales_qty)-0.000001;
  const lineStatus=closed?'closed':complete?'fulfilled':Number(totals.held)>0?'approved':'submitted';
  await query('UPDATE sales_stock_request_lines SET status=$2,updated_at=now() WHERE id=$1',[row.request_line_id,lineStatus]);
  await query('UPDATE sales_stock_requests SET status=$2,cancelled_at=CASE WHEN $3 THEN COALESCE(cancelled_at,now()) ELSE cancelled_at END WHERE id=$1',
    [id,closed?'cancelled':complete?'completed':Number(totals.held)>0?'active':'submitted',closed]);
}

/** @param {Record<string,any>} [input] @param {{operatorId?:string,authorizedDestinationLocationIds?:number[]}} [context] */
export async function submitWaitlistRequest(input={},context={}){
  if(!context.operatorId)throw waitlistError('A Sales operator is required.','WAITLIST_FORBIDDEN',403);
  const destinationLocationId=assertStockRequestDestinationAccess(input.destinationLocationId,context.authorizedDestinationLocationIds);
  if(!Array.isArray(input.lines) || input.lines.length!==1)throw waitlistError('A waitlist request must contain exactly one item.');
  const normalized={operationKey:waitlistKey(input.operationKey),destinationLocationId,customerId:waitlistId(input.customerId),
    itemId:waitlistId(input.lines[0].itemId),quantity:waitlistQuantity(input.lines[0].salesQty),remarks:String(input.remarks||'').trim().slice(0,8000)};
  const result=await withWaitlistTransaction(()=>command('submit:'+context.operatorId,normalized,context,async()=>{
    const customer=await findSpecialCustomer(normalized.customerId);
    if(!customer)throw waitlistError('Select an active existing customer.','WAITLIST_CUSTOMER_INVALID',409);
    const item=(await query('SELECT item_type,stock_unit FROM inventory_items WHERE item_id=$1 FOR SHARE',[normalized.itemId])).rows[0];
    if(!item?.stock_unit || (item.item_type && item.item_type!=='InvtPart'))throw waitlistError('Select an ordinary inventory item with a sales unit.','WAITLIST_ITEM_INVALID',400);
    const request=await createSalesStockRequest({deliveryMethod:'waitlist',destinationLocationId,remarks:normalized.remarks,
      lines:[{itemId:normalized.itemId,salesQty:normalized.quantity}]},{...context,allowOverAvailability:false});
    await query('INSERT INTO regular_waitlist_requests(request_id,request_line_id,customer_id) VALUES($1,$2,$3)',[request.id,request.lines[0].id,normalized.customerId]);
    await query(`UPDATE sales_stock_requests SET workflow_version=2,regular_details=$2::jsonb WHERE id=$1`,[request.id,
      JSON.stringify({deliveryMethod:'waitlist',stockingType:'waitlist',customerId:normalized.customerId,customerName:customer.label||customer.displayName||customer.name})]);
    return {requestId:request.id};
  }));
  return getWaitlistRequest(result.requestId,context);
}
function mapAllocation(row){
  return {id:Number(row.id),requestId:Number(row.request_id),poolId:Number(row.pool_id),quantity:Number(row.quantity),status:row.status,
    purchaseOrderRef:row.po_ref,allocatedAt:iso(row.allocated_at),releasedAt:iso(row.released_at),releaseReason:row.release_reason,
    overrideReason:row.override_reason,eta:row.expected_delivery_date,...waitlistReleaseEligibility({status:row.status,allocatedAt:row.allocated_at})};
}
function mapConversion(row){
  return {id:row.id,requestId:Number(row.request_id),quantity:Number(row.quantity),status:row.status,remainderAction:row.remainder_action,
    fulfillment:row.fulfillment,salesOrderId:row.sales_order_id?Number(row.sales_order_id):null,salesOrderRef:row.sales_order_ref,
    error:row.error,createdAt:iso(row.requested_at)};
}
export async function decorateWaitlistRequest(request){
  const row=(await query('SELECT * FROM regular_waitlist_requests WHERE request_id=$1',[request.id])).rows[0];
  if(!row)return request;
  const allocations=(await query(`SELECT a.*,COALESCE(NULLIF(o.dispatch_ref,''),o.tranid) AS po_ref,o.expected_delivery_date
    FROM regular_waitlist_allocations a JOIN regular_waitlist_pools p ON p.id=a.pool_id JOIN purchase_orders o ON o.netsuite_id=p.purchase_order_id
    WHERE a.request_id=$1 ORDER BY a.id`,[request.id])).rows.map(mapAllocation);
  const conversions=(await query('SELECT * FROM regular_waitlist_conversions WHERE request_id=$1 ORDER BY requested_at,id',[request.id])).rows.map(mapConversion);
  const held=allocations.filter(a=>['reserved','converting'].includes(a.status)).reduce((n,a)=>n+a.quantity,0);
  const committed=allocations.filter(a=>a.status==='committed').reduce((n,a)=>n+a.quantity,0);
  const totals=waitlistTotals({requested:request.lines[0].salesQty,held,committed,closed:Boolean(row.closed_at)});
  const converting=conversions.some(c=>['pending','preparing','submitted','uncertain'].includes(c.status));
  const state=row.closed_at?'closed':converting?'converting':totals.remainingQty===0?'completed':held>0?(totals.waitingQty>0?'partially_allocated':'allocated'):'waiting';
  const closureType=row.closed_at?((request.events||[]).some(event=>event.eventType==='waitlist_rejected')?'rejected':'closed'):null;
  request.waitlist={...totals,state,closureType,closedAt:iso(row.closed_at),closeReason:row.close_reason,allocations,conversions};
  request.createdAt=iso(request.createdAt);request.updatedAt=iso(request.updatedAt);
  request.bucket=['closed','completed'].includes(state)?'completed':held>0||converting?'accepted':'pending';request.availability=[];
  return request;
}
export async function getWaitlistRequest(id,context){
  const request=await getScmStockRequest(waitlistId(id));
  if(!isWaitlist(request))throw waitlistError('Waitlist request was not found.','WAITLIST_NOT_FOUND',404);
  if(context)assertStockRequestDestinationAccess(request.destinationLocationId,context.authorizedDestinationLocationIds);
  return request;
}
export async function listWaitlistRequests({itemId=null,includeClosed=false,search='',includeSupply=true}={}){
  const rows=(await query(`SELECT r.id,r.request_ref,r.revision,r.destination_location_id,r.destination_name,r.created_at,r.regular_details,
    w.closed_at,l.item_id,l.item_name,l.sales_qty,l.sales_uom,i.vendor_id,i.vendor,i.display_name,
    COALESCE(SUM(a.quantity) FILTER(WHERE a.status IN ('reserved','converting')),0) AS held,
    COALESCE(SUM(a.quantity) FILTER(WHERE a.status='committed'),0) AS converted,
    EXISTS(SELECT 1 FROM regular_waitlist_conversions c WHERE c.request_id=r.id AND c.status IN ${activeConversions}) AS converting
    FROM regular_waitlist_requests w JOIN sales_stock_requests r ON r.id=w.request_id
    JOIN sales_stock_request_lines l ON l.id=w.request_line_id LEFT JOIN inventory_items i ON i.item_id=l.item_id
    LEFT JOIN regular_waitlist_allocations a ON a.request_id=r.id
    WHERE ($1::bigint IS NULL OR l.item_id=$1) AND ($2 OR (w.closed_at IS NULL AND r.status<>'completed'))
    AND ($3='' OR strpos(lower(r.request_ref||' '||COALESCE(r.regular_details->>'customerName','')||' '||l.item_name),lower($3))>0)
    GROUP BY r.id,w.request_id,l.id,i.vendor_id,i.vendor,i.display_name ORDER BY r.created_at,r.id`,[itemId,includeClosed,String(search).slice(0,120)])).rows;
  const recent=includeSupply?await recentQueuedWaitlistPurchaseOrders(rows.map(row=>Number(row.item_id))):new Map();
  return rows.map(row=>({id:Number(row.id),requestRef:row.request_ref,revision:Number(row.revision),sellingYardId:Number(row.destination_location_id),
    sellingYard:row.destination_name,createdAt:iso(row.created_at),itemId:Number(row.item_id),itemCode:row.item_name,itemDisplayName:row.display_name||row.item_name,salesUom:row.sales_uom,
    vendorId:row.vendor_id?Number(row.vendor_id):null,vendorName:row.vendor||'',vendorKey:row.vendor_id?String(row.vendor_id):row.vendor?'name:'+row.vendor.toLowerCase():'none',
    recentQueuedPurchaseOrders:recent.get(Number(row.item_id))||[],
    customerId:row.regular_details.customerId,customerName:row.regular_details.customerName,converting:row.converting,closed:Boolean(row.closed_at),
    destinationLocationId:Number(row.destination_location_id),waitlist:{waitingQty:Math.max(0,Number(row.sales_qty)-Number(row.held)-Number(row.converted))},
    ...waitlistTotals({requested:Number(row.sales_qty),held:Number(row.held),committed:Number(row.converted),closed:Boolean(row.closed_at)})}));
}
async function poolRow(id){
  const row=(await query(`SELECT p.*,COALESCE(NULLIF(o.dispatch_ref,''),o.tranid) AS po_ref,o.expected_delivery_date,
    i.item_name AS item_code,i.display_name,i.brand FROM regular_waitlist_pools p JOIN purchase_orders o ON o.netsuite_id=p.purchase_order_id
    JOIN inventory_items i ON i.item_id=p.item_id WHERE p.id=$1`,[id])).rows[0];
  if(!row)throw waitlistError('Waitlist pool was not found.','WAITLIST_POOL_NOT_FOUND',404);return row;
}
/** @param {unknown} id @param {{operatorId?:string}} [context] */
export async function getWaitlistPool(id,context={}){
  const row=await poolRow(waitlistId(id));let supply;
  try{supply=await waitlistPoolSupply(row);}catch(error){if(!['WAITLIST_PO_UNIT_INVALID','WAITLIST_PO_LINEAGE_CONFLICT','WAITLIST_INVALID'].includes(error.code))throw error;supply={capacityQty:0,sourceAvailableQty:0,attention:error.message};}
  const allocations=(await query(`SELECT a.*,COALESCE(NULLIF(o.dispatch_ref,''),o.tranid) AS po_ref,o.expected_delivery_date,r.request_ref,
    r.destination_name,r.regular_details FROM regular_waitlist_allocations a JOIN regular_waitlist_pools p ON p.id=a.pool_id
    JOIN purchase_orders o ON o.netsuite_id=p.purchase_order_id JOIN sales_stock_requests r ON r.id=a.request_id WHERE a.pool_id=$1 ORDER BY a.id`,[id])).rows;
  const balance=waitlistPoolBalance(supply.capacityQty,allocations.map(a=>({quantity:Number(a.quantity),status:a.status})));
  const read=context.operatorId?(await query('SELECT event_id FROM regular_waitlist_pool_reads WHERE pool_id=$1 AND operator_id=$2',[id,context.operatorId])).rows[0]:null;
  const requests=rankWaitlistRequests((await listWaitlistRequests({itemId:Number(row.item_id),includeSupply:false})).filter(r=>r.waitingQty>0&&!r.converting),row.item_code,row.brand);
  return {id:Number(row.id),revision:Number(row.revision),purchaseOrderId:Number(row.purchase_order_id),purchaseOrderRef:row.po_ref,itemId:Number(row.item_id),
    itemCode:row.item_code,itemName:row.display_name||row.item_code,salesUom:row.sales_uom,eta:row.expected_delivery_date,...balance,
    availableQty:supply.attention?0:Math.min(balance.availableQty,supply.sourceAvailableQty),attention:supply.attention,
    lastReturnEventId:Number(row.last_return_event_id),returnedUnread:Number(row.last_return_event_id)>Number(read?.event_id||0),requests,
    allocations:allocations.map(a=>({...mapAllocation(a),requestRef:a.request_ref,sellingYard:a.destination_name,customerName:a.regular_details.customerName}))};
}
/** @param {{operatorId?:string}} [context] */
export async function listWaitlistPools(context={}){
  const rows=(await query('SELECT id FROM regular_waitlist_pools ORDER BY updated_at DESC,id DESC LIMIT 200')).rows;
  return Promise.all(rows.map(row=>getWaitlistPool(Number(row.id),context)));
}
export async function createWaitlistPool(input,context){
  const normalized={operationKey:waitlistKey(input.operationKey),purchaseOrderRef:waitlistText(input.purchaseOrderRef,{required:true}),itemId:waitlistId(input.itemId)};
  const result=await withWaitlistTransaction(()=>command('pool:create',normalized,context,async()=>{
    const po=await resolveWaitlistPo(normalized.purchaseOrderRef);
    const item=(await query('SELECT stock_unit FROM inventory_items WHERE item_id=$1 FOR SHARE',[normalized.itemId])).rows[0];
    if(!item?.stock_unit)throw waitlistError('Select an ordinary inventory item with a sales unit.');
    const supply=await waitlistPoolSupply({purchase_order_id:po.netsuite_id,item_id:normalized.itemId,sales_uom:item.stock_unit},{lock:true});
    if(supply.attention || supply.capacityQty<=0)throw waitlistError(supply.attention||'This PO has no allocatable item quantity.','WAITLIST_PO_UNAVAILABLE',409);
    const row=(await query(`INSERT INTO regular_waitlist_pools(purchase_order_id,item_id,sales_uom,created_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(purchase_order_id,item_id) DO UPDATE SET purchase_order_id=EXCLUDED.purchase_order_id RETURNING id`,[po.netsuite_id,normalized.itemId,item.stock_unit,context.operatorId])).rows[0];
    return {poolId:Number(row.id)};
  }));return getWaitlistPool(result.poolId,context);
}
async function releaseEvent(allocation,reason,actor,type){
  await query(`UPDATE regular_waitlist_allocations SET status='released',released_at=now(),released_by=$2,release_reason=$3 WHERE id=$1 AND status='reserved'`,[allocation.id,actor||null,reason]);
  const eventId=await notice(Number(allocation.request_id),type,actor,{allocationId:Number(allocation.id),poolId:Number(allocation.pool_id),quantity:Number(allocation.quantity),reason});
  await query('UPDATE regular_waitlist_allocations SET release_event_id=$2 WHERE id=$1',[allocation.id,eventId]);
  await query('UPDATE regular_waitlist_pools SET last_return_event_id=$2 WHERE id=$1',[allocation.pool_id,eventId]);
  await touchPools([Number(allocation.pool_id)]);await refreshRequestStatus(Number(allocation.request_id));
}
async function expireWithinTransaction({requestId=null,itemId=null,now=new Date(),limit=50}={}){
  const rows=(await query(`SELECT a.* FROM regular_waitlist_allocations a
    JOIN regular_waitlist_requests own ON own.request_id=a.request_id JOIN sales_stock_request_lines line ON line.id=own.request_line_id
    WHERE a.status='reserved' AND a.allocated_at<=$1 AND ($2::bigint IS NULL OR a.request_id=$2) AND ($3::bigint IS NULL OR line.item_id=$3)
    AND NOT EXISTS(SELECT 1 FROM regular_waitlist_conversions c WHERE c.request_id=a.request_id AND c.status IN ${activeConversions})
    AND EXISTS(SELECT 1 FROM regular_waitlist_requests competitor JOIN sales_stock_requests r ON r.id=competitor.request_id
      JOIN sales_stock_request_lines l ON l.id=competitor.request_line_id WHERE competitor.request_id<>a.request_id AND competitor.closed_at IS NULL
      AND r.status NOT IN ('completed','cancelled') AND l.item_id=line.item_id
      AND l.sales_qty>(SELECT COALESCE(SUM(other.quantity),0) FROM regular_waitlist_allocations other
        WHERE other.request_id=r.id AND other.status IN ('reserved','converting','committed'))+0.000001)
    ORDER BY a.allocated_at,a.id LIMIT $4 FOR UPDATE OF a`,[new Date(new Date(now).getTime()-WAITLIST_AUTO_RELEASE_MS),requestId,itemId,requestId?10000:limit])).rows;
  for(const allocation of rows)await releaseEvent(allocation,'Unused allocation passed 3 hours with another waiting request.',null,'waitlist_allocation_expired');
  return {allocationIds:rows.map(r=>Number(r.id)),requestIds:[...new Set(rows.map(r=>Number(r.request_id)))],poolIds:[...new Set(rows.map(r=>Number(r.pool_id)))]};
}
export function expireWaitlistAllocations(options={}){return withWaitlistTransaction(()=>expireWithinTransaction(options));}

export async function allocateWaitlistPool(id,input,context){
  id=waitlistId(id);
  if(!Array.isArray(input.selections) || !input.selections.length || input.selections.length>100)throw waitlistError('Select between 1 and 100 requests.');
  const normalized={operationKey:waitlistKey(input.operationKey),expectedRevision:input.expectedRevision,overrideReason:String(input.overrideReason||'').trim().slice(0,2000),
    selections:input.selections.map(s=>({requestId:waitlistId(s.requestId),quantity:waitlistQuantity(s.quantity),expectedRevision:s.expectedRevision}))};
  if(new Set(normalized.selections.map(s=>s.requestId)).size!==normalized.selections.length)throw waitlistError('Select each request once.');
  const result=await withWaitlistTransaction(()=>command('allocate:'+id,normalized,context,async()=>{
    const pool=await poolRow(id);assertRevision(pool,normalized.expectedRevision);
    await expireWithinTransaction({itemId:Number(pool.item_id)});
    const supply=await waitlistPoolSupply(pool,{lock:true});
    if(supply.attention)throw waitlistError(supply.attention,'WAITLIST_PO_UNAVAILABLE',409);
    const ranked=rankWaitlistRequests((await listWaitlistRequests({itemId:Number(pool.item_id),includeSupply:false})).filter(r=>r.waitingQty>0&&!r.converting),pool.item_code,pool.brand);
    const override=assertWaitlistSelectionPriority(ranked,normalized.selections,normalized.overrideReason);
    const quantity=roundWaitlistQuantity(normalized.selections.reduce((sum,s)=>sum+s.quantity,0));
    if(quantity>supply.sourceAvailableQty+0.000001)throw waitlistError('The selected quantity exceeds the PO pool balance.','WAITLIST_POOL_EXCEEDED',409);
    for(const selection of normalized.selections){
      const row=await requestRow(selection.requestId);await assertNotConverting(selection.requestId);assertRevision(row,selection.expectedRevision);
      if(normalizedWaitlistUnit(row.sales_uom)!==normalizedWaitlistUnit(pool.sales_uom))throw waitlistError('The item sales unit changed after this request. Close it and submit the corrected unit.','WAITLIST_DEMAND_UNIT_MISMATCH',409);
      const demand=ranked.find(r=>r.id===selection.requestId);
      if(row.closed_at || Number(row.item_id)!==Number(pool.item_id) || !demand || selection.quantity>demand.waitingQty+0.000001)
        throw waitlistError('The selected quantity exceeds the open request.','WAITLIST_DEMAND_EXCEEDED',409);
      const allocation=(await query(`INSERT INTO regular_waitlist_allocations(request_id,pool_id,quantity,allocated_by,batch_key,override_reason)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[selection.requestId,id,selection.quantity,context.operatorId,normalized.operationKey,override?normalized.overrideReason:null])).rows[0];
      let remaining=selection.quantity;
      for(const source of supply.sources){
        const take=roundWaitlistQuantity(Math.min(remaining,source.availableQty));if(!take)continue;
        await query('INSERT INTO regular_waitlist_allocation_sources(allocation_id,po_line_id,root_line_id,quantity) VALUES($1,$2,$3,$4)',[allocation.id,source.lineId,source.rootLineId,take]);
        remaining=roundWaitlistQuantity(remaining-take);source.availableQty=roundWaitlistQuantity(source.availableQty-take);
      }
      if(remaining>0)throw waitlistError('PO source capacity changed.','WAITLIST_POOL_EXCEEDED',409);
      await notice(selection.requestId,'waitlist_allocation_confirmed',context.operatorId,{allocationId:Number(allocation.id),poolId:id,quantity:selection.quantity,purchaseOrderRef:pool.po_ref,overrideReason:override?normalized.overrideReason:null});
      await query('UPDATE sales_stock_requests SET first_scm_decision_at=COALESCE(first_scm_decision_at,now()) WHERE id=$1',[selection.requestId]);
      await refreshRequestStatus(selection.requestId);
    }
    await touchPools([id]);return {poolId:id};
  }));return getWaitlistPool(result.poolId,context);
}
async function closeWaitlistDemand(id,input,context,{scmReject=false}={}){
  id=waitlistId(id);const normalized={operationKey:waitlistKey(input.operationKey),expectedRevision:input.expectedRevision,reason:waitlistText(input.reason,{required:true})};
  const result=await withWaitlistTransaction(async()=>{
    const row=await requestRow(id,scmReject?undefined:context);
    return command((scmReject?'reject:':'close:')+id,normalized,context,async()=>{
      await assertNotConverting(id);assertRevision(row,normalized.expectedRevision);
      if(row.closed_at)throw waitlistError('This request is already closed.','WAITLIST_CLOSED',409);
      if(scmReject&&row.status==='completed')throw waitlistError('This request has already been fully converted.','WAITLIST_COMPLETED',409);
      const holds=(await query("SELECT * FROM regular_waitlist_allocations WHERE request_id=$1 AND status='reserved' ORDER BY id",[id])).rows;
      for(const hold of holds)await releaseEvent(hold,normalized.reason,context.operatorId,'waitlist_allocation_released');
      await query('UPDATE regular_waitlist_requests SET closed_at=now(),closed_by=$2,close_reason=$3 WHERE request_id=$1',[id,context.operatorId,normalized.reason]);
      if(scmReject)await query('UPDATE sales_stock_requests SET first_scm_decision_at=COALESCE(first_scm_decision_at,now()) WHERE id=$1',[id]);
      await notice(id,scmReject?'waitlist_rejected':'waitlist_closed',context.operatorId,{reason:normalized.reason},{notify:scmReject});await refreshRequestStatus(id);return {requestId:id};
    });
  });return getWaitlistRequest(result.requestId,scmReject?undefined:context);
}
export const closeWaitlistRequest=(id,input,context)=>closeWaitlistDemand(id,input,context);
export async function rejectWaitlistRequest(id,input,context={}){
  if(!context.operatorId)throw waitlistError('An SCM operator is required.','WAITLIST_FORBIDDEN',403);
  return closeWaitlistDemand(id,input,context,{scmReject:true});
}
export async function releaseWaitlistAllocation(id,input,context){
  id=waitlistId(id);const normalized={operationKey:waitlistKey(input.operationKey),expectedRevision:input.expectedRevision,reason:waitlistText(input.reason,{required:true})};
  const result=await withWaitlistTransaction(()=>command('release:'+id,normalized,context,async()=>{
    const allocation=(await query('SELECT * FROM regular_waitlist_allocations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!allocation)throw waitlistError('Allocation was not found.','WAITLIST_NOT_FOUND',404);
    const row=await requestRow(Number(allocation.request_id));await assertNotConverting(row.id);assertRevision(row,normalized.expectedRevision);
    if(!waitlistReleaseEligibility({status:allocation.status,allocatedAt:allocation.allocated_at}).manualAllowed)
      throw waitlistError('SCM can release an unused allocation after 30 minutes.','WAITLIST_RELEASE_TOO_EARLY',409);
    await releaseEvent(allocation,normalized.reason,context.operatorId,'waitlist_allocation_released');return {poolId:Number(allocation.pool_id)};
  }));return getWaitlistPool(result.poolId,context);
}
export async function claimWaitlistConversion(id,input,context){
  id=waitlistId(id);const normalized={operationKey:waitlistKey(input.operationKey),expectedRevision:input.expectedRevision,
    remainderAction:input.remainderAction||'keep',fulfillment:normalizeWaitlistFulfillment(input)};
  if(!['keep','close'].includes(normalized.remainderAction))throw waitlistError('Choose whether to keep or close the remaining demand.');
  const result=await withWaitlistTransaction(async()=>{
    const row=await requestRow(id,context);
    return command('convert:'+id,normalized,context,async()=>{
      await assertNotConverting(id);assertRevision(row,normalized.expectedRevision);await expireWithinTransaction({requestId:id});
      if(row.closed_at)throw waitlistError('This request is closed.','WAITLIST_CLOSED',409);
      if(!await findSpecialCustomer(Number(row.customer_id)))throw waitlistError('This customer is no longer active.','WAITLIST_CUSTOMER_INVALID',409);
      const holds=(await query("SELECT * FROM regular_waitlist_allocations WHERE request_id=$1 AND status='reserved' ORDER BY id",[id])).rows;
      const quantity=roundWaitlistQuantity(holds.reduce((sum,a)=>sum+Number(a.quantity),0));
      if(!quantity)throw waitlistError('No current allocation remains. Refresh the request.','WAITLIST_NO_ALLOCATION',409);
      for(const poolId of new Set(holds.map(a=>Number(a.pool_id)))){
        const supply=await waitlistPoolSupply(await poolRow(poolId),{lock:true});
        if(supply.attention)throw waitlistError(supply.attention,'WAITLIST_PO_UNAVAILABLE',409);
      }
      const conversionId=randomUUID();
      await query(`INSERT INTO regular_waitlist_conversions(id,request_id,operation_key,quantity,remainder_action,fulfillment,actor_id)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,[conversionId,id,normalized.operationKey,quantity,normalized.remainderAction,JSON.stringify(normalized.fulfillment),context.operatorId]);
      await query("UPDATE regular_waitlist_allocations SET status='converting',conversion_id=$2 WHERE request_id=$1 AND status='reserved'",[id,conversionId]);
      await notice(id,'waitlist_conversion_requested',context.operatorId,{conversionId,quantity},{notify:false});
      await touchPools(holds.map(a=>Number(a.pool_id)));return {conversionId};
    });
  });return getWaitlistConversion(result.conversionId);
}
export async function getWaitlistConversion(id){
  const row=(await query(`SELECT c.*,r.revision,r.request_ref,r.destination_location_id,r.destination_name,w.customer_id,l.item_id,l.item_name,l.sales_uom
    FROM regular_waitlist_conversions c JOIN sales_stock_requests r ON r.id=c.request_id JOIN regular_waitlist_requests w ON w.request_id=r.id
    JOIN sales_stock_request_lines l ON l.id=w.request_line_id WHERE c.id=$1`,[waitlistKey(id)])).rows[0];
  if(!row)throw waitlistError('SO conversion was not found.','WAITLIST_NOT_FOUND',404);
  return {...mapConversion(row),requestRevision:Number(row.revision),requestRef:row.request_ref,customerId:Number(row.customer_id),sellingYardId:Number(row.destination_location_id),
    sellingYard:row.destination_name,itemId:Number(row.item_id),itemCode:row.item_name,salesUom:row.sales_uom,remoteStartedAt:iso(row.remote_started_at),payload:row.payload,leaseToken:row.lease_token};
}
export async function finishWaitlistConversion(id,{salesOrderId,salesOrderRef}){
  id=waitlistKey(id);salesOrderId=waitlistId(salesOrderId);salesOrderRef=waitlistText(salesOrderRef);
  await withWaitlistTransaction(async()=>{
    const row=(await query('SELECT * FROM regular_waitlist_conversions WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw waitlistError('SO conversion was not found.','WAITLIST_NOT_FOUND',404);
    if(row.status==='completed'){
      if(Number(row.sales_order_id)!==salesOrderId)throw waitlistError('This conversion already created a different SO.','WAITLIST_CONVERSION_CONFLICT',409);return;
    }
    if(row.status==='failed')throw waitlistError('This conversion failed.','WAITLIST_CONVERSION_CONFLICT',409);
    await query("UPDATE regular_waitlist_conversions SET status='completed',sales_order_id=$2,sales_order_ref=$3,error=NULL,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1",[id,salesOrderId,salesOrderRef]);
    const pools=(await query("UPDATE regular_waitlist_allocations SET status='committed' WHERE conversion_id=$1 AND status='converting' RETURNING pool_id",[id])).rows;
    if(row.remainder_action==='close')await query("UPDATE regular_waitlist_requests SET closed_at=now(),closed_by=$2,close_reason='Sales closed the unconverted remainder.' WHERE request_id=$1",[row.request_id,row.actor_id]);
    await notice(Number(row.request_id),'waitlist_sales_order_created',row.actor_id,{conversionId:id,quantity:Number(row.quantity),salesOrderId,salesOrderRef,remainderAction:row.remainder_action},{notify:false});
    await touchPools(pools.map(p=>Number(p.pool_id)));await refreshRequestStatus(Number(row.request_id));
  });return getWaitlistConversion(id);
}
export async function acknowledgeWaitlistPool(id,{eventId},context){
  id=waitlistId(id);eventId=waitlistId(eventId);
  return withWaitlistTransaction(async()=>{
    const pool=await poolRow(id);
    if(eventId>Number(pool.last_return_event_id) || !(await query("SELECT 1 FROM sales_stock_request_events WHERE id=$1 AND details->>'poolId'=$2",[eventId,String(id)])).rowCount)
      throw waitlistError('Returned-pool notice was not found.');
    await query(`INSERT INTO regular_waitlist_pool_reads(pool_id,operator_id,event_id) VALUES($1,$2,$3)
      ON CONFLICT(pool_id,operator_id) DO UPDATE SET event_id=GREATEST(regular_waitlist_pool_reads.event_id,EXCLUDED.event_id),read_at=now()`,[id,context.operatorId,eventId]);
    return {poolId:id,eventId};
  });
}
