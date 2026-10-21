import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {submitRegularStockRequest,editRegularStockRequest,decideRegularStockRequest,reraiseRegularStockRequest,regularStockAlerts} from '../../../src/regular-stock-request-service.js';
import {getScmStockRequest,listScmStockRequests} from '../../../src/stock-request-repository.js';
import {getSmartScmSettings,updateSmartScmSettings} from '../../../src/smart-scm-repository.js';
import {previewPickupStockTransfers,convertPickupStockTransfers} from '../../../src/regular-stock-pickup.js';
import {previewRegularStockSalesOrder,linkRegularStockSalesOrder} from '../../../src/regular-stock-handoff.js';

const actor='stocking-methods-'+randomUUID(),itemId=9800000000091;
const context={operatorId:actor,authorizedDestinationLocationIds:[28],allowOverAvailability:true};
const now=()=>new Date('2099-01-15T20:00:00Z');
const deps={liveExecutionEnabled:true,now,refreshAvailability:async()=>{},loadPolicies:async()=>[{itemId,sourceLocationId:1,availableQuantity:1000,safetyQuantity:800}]};
const input=(method,quantity=200)=>({destinationLocationId:28,deliveryMethod:method,...(method==='delivery'?{arrivalDate:'2099-01-15',arrivalTime:'15:00'}:{}),lines:[{itemId,sourceLocationId:1,pieces:quantity}]});
const create=(method,quantity=200)=>submitRegularStockRequest(input(method,quantity),context,deps);
const draft=request=>({expectedRevision:request.revision,lines:request.lines.map(line=>({id:line.id,itemId,sourceLocationId:1,pieces:200})),palletQuantities:{1:2}});
let settings;
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');settings=await getSmartScmSettings();
 await updateSmartScmSettings({regularStockAutoApprovalEnabled:true,regularStockLeadHours:12,regularStockApprovalMinutes:15});
 await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','scm',ARRAY['scm'],true)",[actor]);
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'STOCKING-METHOD-ITEM','EA',1,100) ON CONFLICT DO NOTHING",[itemId]);
 await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',1000,1000,now()) ON CONFLICT DO NOTHING",[itemId]);
});
after(async()=>{await updateSmartScmSettings({regularStockAutoApprovalEnabled:settings.regularStockAutoApprovalEnabled,regularStockLeadHours:settings.regularStockLeadHours,regularStockApprovalMinutes:settings.regularStockApprovalMinutes});await closeDb();});
test('date-free methods ignore stale inputs and Delivery still validates both fields on create and edit',async()=>{
 for(const method of ['pickup','stocking']){
  const request=await submitRegularStockRequest({...input(method),arrivalDate:'2026-02-30',arrivalTime:'invalid'},context,deps);
  for(const key of ['arrivalDate','arrivalTime','arrivalAt'])assert.equal(request.regular[key],null);
  assert.equal(request.regular.approval.arrivalAt,null);
 }
 for(const missing of [{arrivalDate:undefined},{arrivalTime:undefined},{arrivalDate:'2026-02-30'},{arrivalTime:'25:00'}]){
  await assert.rejects(()=>submitRegularStockRequest({...input('delivery'),...missing},context,deps),{code:'REGULAR_ARRIVAL_INVALID'});
 }
 let request=await create('delivery',201);
 for(const method of ['pickup','stocking']){
  request=await editRegularStockRequest(request.id,{...input(method,201),expectedRevision:request.revision},context,deps);
  assert.equal(request.regular.deliveryMethod,method);assert.equal(request.regular.arrivalDate,null);assert.equal(request.regular.arrivalTime,null);assert.equal(request.regular.arrivalAt,null);
 }
 await assert.rejects(()=>editRegularStockRequest(request.id,{...input('pickup',201),deliveryMethod:'delivery',expectedRevision:request.revision},context,deps),{code:'REGULAR_ARRIVAL_INVALID'});
 request=await editRegularStockRequest(request.id,{...input('delivery',201),expectedRevision:request.revision},context,deps);
 assert.equal(request.regular.arrivalDate,'2099-01-15');assert.equal(request.regular.arrivalTime,'15:00');assert.equal(request.regular.arrivalAt,'2099-01-15T20:00:00.000Z');
});
test('immediate Pickup pre-approves, immediate Delivery waits for lead time, and Stocking always waits for SCM',async()=>{
 const pickup=await create('pickup'),delivery=await create('delivery'),stocking=await create('stocking');
 assert.equal(pickup.regular.approval.automatic,true);assert.equal(pickup.lines[0].status,'approved');assert.equal(pickup.regular.approval.leadTimeApplies,false);
 assert.equal(new Date(pickup.regular.approvalExpiresAt)-now(),15*60000);
 assert.equal(delivery.regular.approval.automatic,false);assert(delivery.lines[0].approvalEvidence.reasons.includes('short_lead_time'));
 assert.equal(stocking.regular.approval.automatic,false);assert.equal(stocking.regular.approvalExpiresAt,null);assert(stocking.lines[0].approvalEvidence.reasons.includes('stocking_scm_review'));
 const pending=await listScmStockRequests({queue:'request',limit:200});const approved=await listScmStockRequests({queue:'approved',limit:200});
 assert(!pending.some(row=>row.id===pickup.id));assert(pending.some(row=>row.id===stocking.id));assert(approved.some(row=>row.id===pickup.id));assert(!approved.some(row=>row.id===stocking.id));
 for(const method of ['', 'unknown'])await assert.rejects(()=>create(method),{code:'REGULAR_DELIVERY_REQUIRED'});
});
test('Pickup shortages and gate-off still need SCM and support the existing manual stock or PO approval',async()=>{
 let request=await create('pickup',201);assert.equal(request.regular.approval.automatic,false);
 assert.deepEqual(request.lines[0].approvalEvidence.reasons,['below_safety']);
 request=await decideRegularStockRequest(request.id,{expectedRevision:request.revision,lineIds:[request.lines[0].id],decision:'stock'},context,deps);
 assert.equal(request.lines[0].decision,'stock');assert(request.regular.approvalExpiresAt);assert(request.manualDecisionEventId>0);
 const alerts=await regularStockAlerts({operatorId:actor,authorizedDestinationLocationIds:[28]});assert(alerts.requests.some(row=>row.id===request.id));
 await updateSmartScmSettings({regularStockAutoApprovalEnabled:false});
 try{
  let gated=await create('pickup');assert.equal(gated.regular.approval.automatic,false);assert.deepEqual(gated.lines[0].approvalEvidence.reasons,['auto_approval_disabled']);
  gated=await decideRegularStockRequest(gated.id,{expectedRevision:gated.revision,lineIds:[gated.lines[0].id],decision:'po'},context,deps);
  assert.equal(gated.lines[0].decision,'po');assert(gated.regular.approvalExpiresAt);
 }finally{await updateSmartScmSettings({regularStockAutoApprovalEnabled:true});}
});
test('pre-approved Pickup follows exact SO matching, confirmation and saved location handoff',async()=>{
 const request=await create('pickup'),ref='SO-STOCKING-PICKUP-'+request.id;
 const order={id:860000+request.id,ref,locationId:28,lines:[{remoteLineId:1,itemId,quantity:200,uom:'EA',locationId:28,open:true}]};
 let writes=0;const boundary={...deps,readOrder:async()=>order,applyLocation:async()=>{writes++;},hydrateOrder:async()=>{},syncReplenishments:async()=>{}};
 await assert.rejects(()=>previewRegularStockSalesOrder(request.id,{salesOrderRef:ref},context,{...boundary,readOrder:async()=>({...order,lines:[{...order.lines[0],quantity:201}]})}),/Quantity mismatch/);
 const preview=await previewRegularStockSalesOrder(request.id,{salesOrderRef:ref},context,boundary);assert.equal(preview.action.mode,'location');assert.equal(writes,0);
 const body={salesOrderRef:ref,expectedRevision:request.revision,confirmationToken:preview.confirmationToken};
 const completed=await linkRegularStockSalesOrder(request.id,body,context,boundary);
 assert.equal(writes,1);assert.equal(completed.regular.handoffStatus,'complete');assert.equal(completed.regular.deliveryMethod,'pickup');assert.equal(completed.regular.pickupTransfer,undefined);
 await linkRegularStockSalesOrder(request.id,body,context,boundary);assert.equal(writes,1);
});
test('expired unused Pickup re-raises without imposing lead time',async()=>{
 const request=await create('pickup');let reads=0;
 await query("UPDATE sales_stock_requests SET regular_details=regular_details||'{\"approvalExpiresAt\":\"2000-01-01T00:00:00Z\"}'::jsonb WHERE id=$1",[request.id]);
 await assert.rejects(()=>previewRegularStockSalesOrder(request.id,{salesOrderRef:'SO-EXPIRED'},context,{...deps,readOrder:async()=>{reads++;}}),{code:'REGULAR_APPROVAL_EXPIRED'});assert.equal(reads,0);
 const raised=await reraiseRegularStockRequest(request.id,{expectedRevision:request.revision},context,deps);
 assert.equal(raised.regular.approval.automatic,true);assert.equal(raised.regular.approval.leadTimeApplies,false);assert.equal(raised.revision,request.revision+1);
});
test('cross-workflow guards reject direct conversion for Pickup/Delivery and SO entry for Stocking',async()=>{
 for(const method of ['pickup','delivery']){
  const request=await create(method);
  await assert.rejects(()=>previewPickupStockTransfers(request.id,draft(request),context,deps),{code:'REGULAR_PICKUP_REQUIRED'});
 }
 const request=await create('stocking');let reads=0;
 await assert.rejects(()=>previewRegularStockSalesOrder(request.id,{salesOrderRef:'SO-FORBIDDEN'},context,{...deps,readOrder:async()=>{reads++;}}),{code:'REGULAR_PICKUP_SCM_REQUIRED'});
 assert.equal(reads,0);assert.equal((await getScmStockRequest(request.id)).transfers.length,0);
});
test('Stocking conversion preserves legacy direct-TO retry identifiers and never creates a Sales Order handoff',async()=>{
 const request=await create('stocking'),input=draft(request),preview=await previewPickupStockTransfers(request.id,input,context,deps);
 let writes=0;const boundary={...deps,confirmTransfer:async transfer=>{writes++;await query("UPDATE sales_stock_transfers SET confirmation_status='complete',status='pending_fulfillment',netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3 WHERE id=$1",[transfer.id,900000+transfer.id,`TO-STOCKING-${transfer.id}`]);}};
 const complete=await convertPickupStockTransfers(request.id,{...input,confirmationToken:preview.confirmationToken},context,boundary);
 assert.equal(complete.regular.pickupTransfer.status,'complete');assert.equal(writes,1);assert.equal(complete.regular.deliveryMethod,'stocking');
 assert.equal((await query('SELECT 1 FROM regular_stock_handoffs WHERE request_id=$1',[request.id])).rowCount,0);
 await query("UPDATE sales_stock_requests SET regular_details=jsonb_set(regular_details,'{deliveryMethod}','\"pickup\"') WHERE id=$1",[request.id]);
 const resume=await previewPickupStockTransfers(request.id,{},context,deps);
 await convertPickupStockTransfers(request.id,{confirmationToken:resume.confirmationToken},context,boundary);
 assert.equal(writes,1);assert.equal((await getScmStockRequest(request.id)).transfers[0].id,complete.transfers[0].id);
});
