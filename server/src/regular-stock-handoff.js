import {deliveryProgress} from './regular-stock-delivery-progress.js';
import { randomUUID } from 'node:crypto';
import { pool, query, withTransaction } from './db.js';
import { config } from './config.js';
import { planRegularStockRouting, regularError, requireRegularStockApproval } from './regular-stock-domain.js';
import { getSalesStockRequest, getScmStockRequest, convertSalesStockRequestLines, recordStockRequestEvent } from './stock-request-repository.js';
import { confirmAndPrintStockTransfer, refreshStockRequestItemsAvailability } from './stock-request-service.js';
import { readRegularStockSalesOrderFromNetSuite, applyRegularStockSalesOrderLocationInNetSuite, createTransferOrderInNetSuite, fetchDeliveryOrderFromNetSuite, fetchDeliveryOrderDetailsFromNetSuite } from './netsuite.js';
import { upsertSalesOrders, upsertSalesOrderLines } from './order-sync-repository.js';
import { createOrderDependency } from './order-dependency-repository.js';
import {describeRegularStockAction,regularStockConfirmationToken,requireRegularStockConfirmation} from './regular-stock-confirmation.js';
import {regularStockKitComponentsMatch} from './regular-stock-netsuite-adapter.js';

// Delivery uses SO line locations as its Base Yard; the SO header may differ.
const describeHandoff = plan => describeRegularStockAction(plan.delivery
  ? {...plan,order:{...plan.order,locationId:plan.groups[0].destinationLocationId}} : plan);

async function hydrateOrder(order) {
  const header = await fetchDeliveryOrderFromNetSuite(order.id);
  if (!header) throw regularError('The linked SO could not be refreshed from NetSuite.');
  await upsertSalesOrders([header]);
  await upsertSalesOrderLines(order.id, await fetchDeliveryOrderDetailsFromNetSuite(order.id));
}

async function requireUnusedSalesOrder(requestId,reference,orderId=null) {
  const existing=(await query(`SELECT r.request_ref FROM regular_stock_handoffs h JOIN sales_stock_requests r ON r.id=h.request_id
    WHERE h.request_id<>$1 AND (upper(btrim(h.sales_order_ref))=upper(btrim($2)) OR h.sales_order_id=$3) LIMIT 1`,[requestId,String(reference || ''),orderId])).rows[0];
  if(existing)throw regularError(`${reference} is already linked to ${existing.request_ref} and cannot be reused for another stock request.`,'REGULAR_SO_REUSED');
}

async function claim(id, input, context, readOrder, now) {
  const before = await getSalesStockRequest(id, context);
  if (before.workflowVersion !== 2) throw regularError('This request uses the legacy transfer workflow.');
  if (before.regular.deliveryVersion === 1 && (before.regular.deliveryApproval !== 'approved' || before.status === 'cancelled')) {
    throw regularError('SCM approval is required before creating this Delivery transfer.', 'REGULAR_APPROVAL_REQUIRED');
  }
  const existing = (await query('SELECT * FROM regular_stock_handoffs WHERE request_id=$1',[id])).rows[0];
  const ref = String(input.salesOrderRef || before.regular.salesOrderRef || '').trim();
  if (!ref) throw regularError('Enter the Sales Order number.', 'REGULAR_SO_REQUIRED', 400);
  if(!existing){requireRegularStockApproval(before,now());await requireUnusedSalesOrder(id,ref);}
  const order = existing ? existing.plan.order : await readOrder(ref);
  return withTransaction(async () => {
    const row = (await query('SELECT * FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
    let handoff = (await query('SELECT * FROM regular_stock_handoffs WHERE request_id=$1 FOR UPDATE',[id])).rows[0];
    if (!handoff) {
      if (Number(input.expectedRevision) !== Number(row.revision)) throw regularError('The request changed. Reload before linking the SO.');
      const request = await getScmStockRequest(id);
      requireRegularStockApproval(request,now());
      if (request.lines.some(line => !['approved','rejected','cancelled'].includes(line.status))) throw regularError('Finish all SCM decisions before entering the SO.');
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`regular-stock-so:${order.id}`]);
      requireRegularStockApproval(request,now());
      await requireUnusedSalesOrder(id,order.ref,order.id);
      const plan = { ...planRegularStockRouting({ request, salesOrder: order, selectedLineIds: input.selectedLineIds || {} }), order };
      requireRegularStockConfirmation(id,plan,input.confirmationToken);
      for (const remoteLineId of plan.materialLineIds) {
        const owner = await query('SELECT request_id FROM regular_stock_so_line_owners WHERE sales_order_id=$1 AND remote_line_id=$2',[order.id,remoteLineId]);
        if (owner.rowCount && Number(owner.rows[0].request_id) !== Number(id)) throw regularError('An SO line already belongs to another stock request.');
        await query('INSERT INTO regular_stock_so_line_owners(sales_order_id,remote_line_id,request_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[order.id,remoteLineId,id]);
      }
      handoff = (await query(`INSERT INTO regular_stock_handoffs(request_id,sales_order_id,sales_order_ref,plan)
        VALUES($1,$2,$3,$4::jsonb) RETURNING *`,[id,order.id,order.ref,JSON.stringify(plan)])).rows[0];
    } else if(handoff.status!=='complete' && before.regular.deliveryVersion !== 1) {
      requireRegularStockConfirmation(id,handoff.plan,input.confirmationToken);
    }
    if (handoff.sales_order_ref.toLowerCase() !== ref.toLowerCase()) throw regularError('This request is already linked to a different SO.');
    if (handoff.status === 'complete') return handoff;
    const attemptId = randomUUID();
    await query(`UPDATE regular_stock_handoffs SET status='executing',attempt_id=$2,lease_until=now()+interval '15 minutes',error=NULL,updated_at=now() WHERE request_id=$1`,[id,attemptId]);
    await query(`UPDATE sales_stock_requests SET regular_details=regular_details||$2::jsonb,revision=revision+1,updated_at=now() WHERE id=$1`,
      [id,JSON.stringify({salesOrderId:Number(handoff.sales_order_id),salesOrderRef:handoff.sales_order_ref,handoffStatus:'executing',handoffError:null,routingMode:handoff.plan.mode,routingAction:describeHandoff(handoff.plan)})]);
    return {...handoff,status:'executing',attempt_id:attemptId};
  });
}

async function linkTransferDependency(request, handoff, transfer, context) {
  await withTransaction(async () => {
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`regular-stock-dependency:${transfer.id}`]);
    const existing = await query(`SELECT id,sales_order_id FROM order_dependencies WHERE transfer_order_id=$1 AND status<>'cancelled'`,[transfer.netsuiteTransferOrderId]);
    if (existing.rowCount) {
      if (Number(existing.rows[0].sales_order_id) !== Number(handoff.sales_order_id)) throw regularError('The TO is linked to a different SO.');
      return;
    }
    const allocationByRemote = new Map();
    for (const mapping of handoff.plan.mappings) {
      if (!transfer.lines.some(line=>line.id===mapping.requestLineId)) continue;
      allocationByRemote.set(mapping.remoteLineId,(allocationByRemote.get(mapping.remoteLineId)||0)+mapping.quantity);
    }
    const allocations=[];
    for (const [remoteLineId,quantity] of allocationByRemote) {
      const canonical=await query('SELECT id,item_id,netsuite_backordered_qty FROM sales_order_lines WHERE sales_order_id=$1 AND line_id=$2',[handoff.sales_order_id,remoteLineId]);
      if(canonical.rowCount!==1)throw regularError('The SO line mirror is not ready. Retry after refresh.');
      allocations.push({salesLineId:Number(canonical.rows[0].id),itemId:Number(canonical.rows[0].item_id),quantity:Number(canonical.rows[0].netsuite_backordered_qty)>0?Math.min(quantity,Number(canonical.rows[0].netsuite_backordered_qty)):quantity});
    }
    await createOrderDependency({salesOrderRef:handoff.sales_order_ref,transferOrderRef:transfer.netsuiteTransferOrderRef,
      mode:'yard_replenishment',allocations,operatorId:context.operatorId});
    await recordStockRequestEvent({requestId:request.id,transferId:transfer.id,eventType:'regular_so_dependency_linked',actorId:context.operatorId,details:{salesOrderRef:handoff.sales_order_ref}});
  });
}

async function executeTransfers(id, handoff, context, dependencies) {
  let request = await getScmStockRequest(id);
  const pending = request.lines.filter(line=>line.status==='approved');
  if(pending.length) {
    await deliveryProgress('checking_stock');
    if(request.regular.deliveryVersion === 1) await (dependencies.refreshAvailability||refreshStockRequestItemsAvailability)(pending.map(line=>line.itemId));
    await deliveryProgress('calculating');
    await convertSalesStockRequestLines(id,{expectedRevision:request.revision,lineIds:pending.map(line=>line.id)}, {...context,approvedHandoff:true});
    request=await getScmStockRequest(id);
    if(request.regular.deliveryVersion === 1) handoff.plan=(await query('SELECT plan FROM regular_stock_handoffs WHERE request_id=$1',[id])).rows[0].plan;
  }
  const confirm=dependencies.confirmTransfer || (async transfer=>{
    // Do not let a printer preflight prevent NetSuite from making its commitment.
    await confirmAndPrintStockTransfer(transfer.id,{expectedRevision:transfer.revision,requestId:`regular-stock:${id}:${transfer.id}`},
      {id:context.operatorId},{ensurePrinter:async()=>{},
        createRemote:(payload,options)=>createTransferOrderInNetSuite({...payload,externalId:`MBBS_REGULAR_STOCK_${id}_${transfer.id}`},options)});
  });
  for(const transfer of request.transfers) {
    let printError;
    if(transfer.confirmationStatus!=='complete') {
      try{await confirm(transfer);}catch(error){
        const saved=(await getScmStockRequest(id)).transfers.find(candidate=>candidate.id===transfer.id);
        // A committed TO must not wait on a printer before replenishment proceeds.
        if(!saved?.netsuiteTransferOrderId || !['pending_fulfillment','partially_fulfilled','pending_receipt','received'].includes(saved.status))throw error;
        if(request.regular.deliveryVersion === 1)printError=error;
      }
    }
    const current=(await getScmStockRequest(id)).transfers.find(candidate=>candidate.id===transfer.id);
    await (dependencies.linkTransferDependency||linkTransferDependency)(request,handoff,current,context);
    if(printError)throw printError;
  }
}

async function complete(id, handoff, context) {
  await withTransaction(async()=>{
    await query('SELECT id FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[id]);
    const saved=await query(`UPDATE regular_stock_handoffs SET status='complete',error=NULL,lease_until=NULL,updated_at=now()
      WHERE request_id=$1 AND attempt_id=$2 RETURNING request_id`,[id,handoff.attempt_id]);
    if(!saved.rowCount)throw regularError('The SO handoff was taken over by another attempt.');
    if(handoff.plan.mode==='location') await query(`UPDATE sales_stock_request_lines SET status='fulfilled',updated_at=now() WHERE request_id=$1 AND regular_decision IN ('stock','po')`,[id]);
    const request=await getScmStockRequest(id);
    const result={handoffStatus:'complete',handoffError:null,routingAction:describeHandoff(handoff.plan),
      routingCompletedAt:new Date().toISOString(),routingTransfers:request.transfers.filter(transfer=>transfer.netsuiteTransferOrderRef)
        .map(transfer=>({reference:transfer.netsuiteTransferOrderRef,sourceName:transfer.sourceName,destinationName:transfer.destinationName}))};
    await query(`UPDATE sales_stock_requests SET regular_details=regular_details||$3::jsonb,
      status=CASE WHEN $2 THEN 'completed' ELSE 'active' END,revision=revision+1,updated_at=now() WHERE id=$1`,[id,handoff.plan.mode==='location',JSON.stringify(result)]);
    await recordStockRequestEvent({requestId:Number(id),eventType:'regular_so_handoff_complete',actorId:context.operatorId,details:{mode:handoff.plan.mode,salesOrderRef:handoff.sales_order_ref,...result}});
  });
}

export async function linkRegularStockSalesOrder(id, input, context, dependencies = {}) {
  const request=await getSalesStockRequest(id,context);
  if(request.regular?.deliveryMethod==='waitlist')throw regularError('Convert the current waitlist allocation to a new SO.','WAITLIST_WORKFLOW_ONLY');
  const client=await pool.connect();
  const key=`regular-stock-handoff:${Number(id)}`;
  const stockLocks=[];
  let acquired=false;
  try{
    acquired=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0].acquired;
    if(!acquired)throw regularError('This SO handoff is already running. Refresh to see its progress.');
    if(request.regular.deliveryVersion === 1) {
      for(const itemId of [...new Set(request.lines.map(line=>line.itemId))].sort((a,b)=>a-b)) {
        const stockKey=`regular-delivery-stock:${request.regular.sourceLocationId}:${itemId}`;
        const locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[stockKey])).rows[0].acquired;
        if(!locked)throw regularError('Another Delivery is using this Target Yard stock. Retry / check progress shortly.','REGULAR_DELIVERY_STOCK_BUSY');
        stockLocks.push(stockKey);
      }
    }
    return await executeHandoff(id,input,context,dependencies);
  }finally{
    for(const stockKey of stockLocks)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[stockKey]).catch(()=>{});
    if(acquired)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{});
    client.release();
  }
}

async function executeHandoff(id, input, context, dependencies) {
  if(!(dependencies.liveExecutionEnabled ?? config.smartScm.liveExecutionEnabled))throw regularError('Live NetSuite execution is disabled.','REGULAR_LIVE_DISABLED');
  const handoff=await claim(id,input,context,dependencies.readOrder||readRegularStockSalesOrderFromNetSuite,dependencies.now||(()=>new Date()));
  if(handoff.status==='complete')return getSalesStockRequest(id,context);
  try {
    if(handoff.plan.mode==='location'&&!handoff.location_applied){
      await query('UPDATE regular_stock_handoffs SET remote_started_at=COALESCE(remote_started_at,now()) WHERE request_id=$1',[id]);
      await (dependencies.applyLocation||applyRegularStockSalesOrderLocationInNetSuite)({order:handoff.plan.order,plan:handoff.plan});
      await query('UPDATE regular_stock_handoffs SET location_applied=true WHERE request_id=$1 AND attempt_id=$2',[id,handoff.attempt_id]);
    }
    await deliveryProgress('checking_so');
    await (dependencies.hydrateOrder||hydrateOrder)(handoff.plan.order);
    if(handoff.plan.mode==='transfer'){
      const fresh=await (dependencies.readOrder||readRegularStockSalesOrderFromNetSuite)(handoff.sales_order_ref);
      const original=handoff.plan.order;
      if(fresh.id!==original.id||fresh.customerId!==original.customerId||fresh.locationId!==original.locationId||fresh.lines.length!==original.lines.length||original.lines.some(line=>{
        const current=fresh.lines.find(row=>row.remoteLineId===line.remoteLineId);
        return !current||current.itemId!==line.itemId||current.quantity!==line.quantity||current.locationId!==line.locationId
          ||!regularStockKitComponentsMatch(line,current)
          ||current.uom!==line.uom||current.restQuantity!==line.restQuantity
          ||(handoff.plan.delivery&&!line.ancillary&&current.backorderedQuantity!==line.backorderedQuantity)
          ||(!current.ancillary&&!current.open&&(!handoff.plan.delivery||handoff.plan.materialLineIds.includes(line.remoteLineId)));
      }))throw regularError('The SO changed after approval was linked. Resolve its lines before retrying.','REGULAR_SO_MISMATCH');
      await executeTransfers(id,handoff,context,dependencies);
    }
    await deliveryProgress('finalizing');
    await (dependencies.refreshAvailability||refreshStockRequestItemsAvailability)([...new Set(handoff.plan.mappings.map(line=>line.itemId))]);
    const request=await getScmStockRequest(id);
    if(dependencies.syncReplenishments)await dependencies.syncReplenishments(request);
    else if(request.lines.some(line=>line.decision==='po')){
      const { enqueueRegularReplenishments,syncRegularReplenishments }=await import('./regular-stock-replenishment.js');
      await enqueueRegularReplenishments(request);
      await syncRegularReplenishments();
    }
    await complete(id,handoff,context);
    return getSalesStockRequest(id,context);
  }catch(error){
    await withTransaction(async()=>{
      const saved=await query(`UPDATE regular_stock_handoffs SET status='attention',error=$3,lease_until=NULL,updated_at=now()
        WHERE request_id=$1 AND attempt_id=$2 RETURNING request_id`,[id,handoff.attempt_id,String(error.message).slice(0,2000)]);
      if(saved.rowCount)await query(`UPDATE sales_stock_requests SET regular_details=regular_details||$2::jsonb,revision=revision+1,updated_at=now() WHERE id=$1`,[id,JSON.stringify({handoffStatus:'attention',handoffError:String(error.message).slice(0,2000)})]);
    });
    throw error;
  }
}

export async function previewRegularStockSalesOrder(id,input,context,{readOrder=readRegularStockSalesOrderFromNetSuite,now=()=>new Date()}={}){
  const request=await getSalesStockRequest(id,context);
  if(request.regular?.deliveryMethod==='waitlist')throw regularError('Convert the current waitlist allocation to a new SO.','WAITLIST_WORKFLOW_ONLY');
  if(request.workflowVersion===2 && (request.regular.deliveryMethod==='stocking' || request.regular.pickupTransfer) && !request.regular.handoffStatus)requireRegularStockApproval(request,now());
  if(request.workflowVersion!==2||request.lines.some(line=>line.status==='submitted'))throw regularError('Finish all SCM decisions before entering the SO.');
  const existing=(await query('SELECT * FROM regular_stock_handoffs WHERE request_id=$1',[id])).rows[0];
  if(existing){
    if(input.salesOrderRef && existing.sales_order_ref.toLowerCase()!==String(input.salesOrderRef).trim().toLowerCase())throw regularError('This request is already linked to a different SO.');
    return {salesOrderRef:existing.sales_order_ref,choices:[],action:describeHandoff(existing.plan),
      confirmationToken:regularStockConfirmationToken(id,existing.plan),resuming:true};
  }
  requireRegularStockApproval(request,now());
  await requireUnusedSalesOrder(id,input.salesOrderRef);
  const order=await readOrder(input.salesOrderRef);
  requireRegularStockApproval(await getSalesStockRequest(id,context),now());
  await requireUnusedSalesOrder(id,order.ref,order.id);
  if(order.locationId!==request.destinationLocationId)throw regularError('The SO must be created at your Sales location.','REGULAR_SO_MISMATCH');
  const choices=[];
  const items=new Set(request.lines.filter(line=>['stock','po'].includes(line.decision)).map(line=>line.itemId));
  for(const itemId of items){
    const quantity=request.lines.filter(line=>line.itemId===itemId&&['stock','po'].includes(line.decision)).reduce((sum,line)=>sum+line.salesQty,0);
    const matches=order.lines.filter(line=>!line.ancillary&&line.open&&line.itemId===itemId&&Math.abs(line.quantity-quantity)<1e-6);
    if(matches.length>1&&!input.selectedLineIds?.[itemId])choices.push({itemId,itemName:matches[0].itemName,lines:matches.map(line=>({id:line.remoteLineId,quantity:line.quantity,uom:line.uom}))});
  }
  if(choices.length)return {salesOrderRef:order.ref,choices};
  const plan={...planRegularStockRouting({request,salesOrder:order,selectedLineIds:input.selectedLineIds || {}}),order};
  return {salesOrderRef:order.ref,choices:[],action:describeRegularStockAction(plan),confirmationToken:regularStockConfirmationToken(id,plan),approvalExpiresAt:request.regular.approvalExpiresAt};
}
