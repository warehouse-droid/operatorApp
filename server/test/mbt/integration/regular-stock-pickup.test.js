import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {submitRegularStockRequest,decideRegularStockRequest} from '../../../src/regular-stock-request-service.js';
import {getScmStockRequest,listScmStockRequests,reviseStockTransferQuantities} from '../../../src/stock-request-repository.js';
import {previewPickupStockTransfers,convertPickupStockTransfers} from '../../../src/regular-stock-pickup.js';
import {previewRegularStockSalesOrder} from '../../../src/regular-stock-handoff.js';
const actor='pickup-'+randomUUID(),itemId=9800000000081,extraId=itemId+1,context={operatorId:actor,authorizedDestinationLocationIds:[28],allowOverAvailability:true};
const deps={liveExecutionEnabled:true,refreshAvailability:async()=>{},loadPolicies:async()=>[itemId,extraId].flatMap(itemId=>[1,15].map(sourceLocationId=>({itemId,sourceLocationId,availableQuantity:10000,safetyQuantity:800}))) };
const create=(lines=[{itemId,sourceLocationId:1,pieces:10}])=>submitRegularStockRequest({destinationLocationId:28,deliveryMethod:'stocking',arrivalDate:'2099-01-15',arrivalTime:'15:00',lines},context,deps);
const draft=request=>({expectedRevision:request.revision,lines:request.lines.filter(line=>line.status!=='rejected').map(line=>({id:line.id,itemId:line.itemId,sourceLocationId:line.sourceLocationId,pieces:25})),palletQuantities:{1:1,15:1}});
const confirm=async transfer=>query("UPDATE sales_stock_transfers SET confirmation_status='complete',status='pending_fulfillment',netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3 WHERE id=$1",[transfer.id,1000000+transfer.id,`TO-PICKUP-${transfer.id}`]);
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','scm',ARRAY['scm'],true)",[actor]);
 for(const id of [itemId,extraId]){
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,$2,'EA',1,100) ON CONFLICT DO NOTHING",[id,`PICKUP-${id}`]);
  for(const yard of [1,15])await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,'Test yard',10000,10000,now()) ON CONFLICT DO NOTHING",[id,yard]);
 }
});
after(closeDb);
test('pickup preview edits quantities and adds an item without writes; confirmed conversion creates real TOs for each source without SO',async()=>{
 const request=await create(),input=draft(request);input.lines.push({itemId:extraId,sourceLocationId:15,pieces:3});
 const preview=await previewPickupStockTransfers(request.id,input,context,deps);
 assert.equal(preview.action.mode,'pickup');assert.equal(preview.action.routes.length,2);assert.deepEqual(preview.lines.map(line=>line.salesQty),[25,3]);
 assert.equal((await getScmStockRequest(request.id)).lines[0].salesQty,10);assert.equal((await getScmStockRequest(request.id)).transfers.length,0);
 let writes=0;const boundary={...deps,confirmTransfer:async transfer=>{writes++;await confirm(transfer);}};
 const result=await convertPickupStockTransfers(request.id,{...input,confirmationToken:preview.confirmationToken},context,boundary);
 assert.equal(writes,2);assert.equal(result.regular.pickupTransfer.status,'complete');assert.deepEqual(result.lines.map(line=>line.salesQty),[25,3]);assert.equal(result.transfers.length,2);
 assert(result.transfers.every(transfer=>transfer.netsuiteTransferOrderRef&&transfer.destinationLocationId===28));assert(result.lines.every(line=>line.status==='converted'));
 assert.equal((await query('SELECT 1 FROM regular_stock_handoffs WHERE request_id=$1',[request.id])).rowCount,0);
 assert(result.manualDecisionEventId>0);assert(result.events.some(event=>event.eventType==='regular_pickup_to_complete'));
 await convertPickupStockTransfers(request.id,{...input,confirmationToken:preview.confirmationToken},context,boundary);assert.equal(writes,2);
});
test('pickup conversion rejects changed quantities, stale revisions, omitted/rejected lines and invalid new items before any edits or TOs',async()=>{
 const request=await create(),input=draft(request),preview=await previewPickupStockTransfers(request.id,input,context,deps);
 let writes=0;const boundary={...deps,confirmTransfer:async()=>{writes++;}};
 await assert.rejects(()=>convertPickupStockTransfers(request.id,{...input,lines:[{...input.lines[0],pieces:26}],confirmationToken:preview.confirmationToken},context,boundary),{code:'REGULAR_CONFIRMATION_CHANGED'});
 for(const edit of [{expectedRevision:request.revision+1},{lines:[]},{lines:[{...input.lines[0],pieces:-1}]},{lines:[{...input.lines[0],sourceLocationId:28}]},{lines:[...input.lines,{itemId:9999999999999,sourceLocationId:1,pieces:1}]},{lines:[input.lines[0],input.lines[0]]}])await assert.rejects(()=>previewPickupStockTransfers(request.id,{...input,...edit},context,deps));
 assert.equal(writes,0);const unchanged=await getScmStockRequest(request.id);assert.equal(unchanged.revision,request.revision);assert.equal(unchanged.lines[0].salesQty,10);assert.equal(unchanged.transfers.length,0);
 await assert.rejects(()=>previewRegularStockSalesOrder(request.id,{salesOrderRef:'SO-NOT-ALLOWED'},context,{readOrder:async()=>{throw Error('Must not read an SO');}}),{code:'REGULAR_PICKUP_SCM_REQUIRED'});
});
test('concurrent pickup confirmation has one execution; partial remote failure retries existing transfers and keeps rejected lines closed',async()=>{
 let request=await create([{itemId,sourceLocationId:1,pieces:10},{itemId:extraId,sourceLocationId:15,pieces:5},{itemId:extraId,sourceLocationId:1,pieces:9}]);
 request=await decideRegularStockRequest(request.id,{expectedRevision:request.revision,lineIds:[request.lines[2].id],decision:'reject',reason:'Not needed'},context,deps);
 const input=draft(request),preview=await previewPickupStockTransfers(request.id,input,context,deps),body={...input,confirmationToken:preview.confirmationToken};
 let writes=0,release,entered;const started=new Promise(resolve=>{entered=resolve;});
 const boundary={...deps,confirmTransfer:async transfer=>{writes++;if(writes===1){entered();await new Promise(resolve=>{release=resolve;});await confirm(transfer);}else throw Error('Remote temporarily unavailable');}};
 const first=convertPickupStockTransfers(request.id,body,context,boundary);await started;
 await assert.rejects(()=>convertPickupStockTransfers(request.id,body,context,boundary),{code:'REGULAR_PICKUP_RUNNING'});release();
 await assert.rejects(()=>first,/temporarily unavailable/);
 const partial=await getScmStockRequest(request.id);assert.equal(partial.regular.pickupTransfer.status,'attention');assert.equal(partial.transfers.length,2);assert.equal(partial.lines[2].status,'rejected');
 const resume=await previewPickupStockTransfers(request.id,{expectedRevision:partial.revision},context,deps);assert.equal(resume.resuming,true);
 const done=await convertPickupStockTransfers(request.id,{confirmationToken:resume.confirmationToken},context,{...deps,confirmTransfer:async transfer=>{writes++;await confirm(transfer);}});
 assert.equal(writes,3);assert.equal(done.regular.pickupTransfer.status,'complete');assert.equal(done.lines[2].status,'rejected');assert.equal(done.lines[2].salesQty,9);
 await assert.rejects(()=>previewPickupStockTransfers(request.id,{...input,lines:[{...input.lines[0],pieces:50}]},context,deps));
});

test('pickup guards prevent live-disabled, missing confirmation, stale conversion, PALLET stock lines and manual-pallet omissions',async()=>{
 const request=await create(),input=draft(request);
 await assert.rejects(()=>convertPickupStockTransfers(request.id,input,context,{...deps,liveExecutionEnabled:false}),{code:'REGULAR_LIVE_DISABLED'});
 await assert.rejects(()=>convertPickupStockTransfers(request.id,input,context,deps),{code:'REGULAR_CONFIRMATION_REQUIRED'});
 for(const pallet of [-1,1e12,'bad'])await assert.rejects(()=>previewPickupStockTransfers(request.id,{...input,palletQuantities:{1:pallet}},context,deps),{code:'REGULAR_PICKUP_PALLETS_INVALID'});
 const auto=await previewPickupStockTransfers(request.id,{...input,palletQuantities:{}},context,deps);assert.equal(auto.action.routes[0].palletQuantity,1);
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs) VALUES($1,'PALLET','EA',1) ON CONFLICT DO NOTHING",[extraId+1]);
 await assert.rejects(()=>previewPickupStockTransfers(request.id,{...input,lines:[...input.lines,{itemId:extraId+1,sourceLocationId:1,pieces:1}]},context,deps),/PALLET quantities/);
 await assert.rejects(()=>previewPickupStockTransfers(request.id,{...input,lines:[{...input.lines[0],itemId:extraId}]},context,deps),/cannot be replaced/);
 await assert.rejects(()=>previewPickupStockTransfers(request.id,{...input,lines:Array.from({length:101},()=>input.lines[0])},context,deps),/100/);
 await query('UPDATE inventory_items SET to_plt=NULL WHERE item_id=$1',[itemId]);
 try {
  await assert.rejects(()=>previewPickupStockTransfers(request.id,{...input,palletQuantities:{}},context,deps),{code:'REGULAR_PICKUP_PALLETS_REQUIRED'});
 } finally {await query('UPDATE inventory_items SET to_plt=100 WHERE item_id=$1',[itemId]);}
 await assert.rejects(()=>decideRegularStockRequest(request.id,{expectedRevision:request.revision,lineIds:[request.lines[0].id],decision:'stock'},context,deps),{code:'REGULAR_PICKUP_SCM_REQUIRED'});
 assert.equal((await getScmStockRequest(request.id)).revision,request.revision);
 await query("UPDATE sales_stock_requests SET regular_details=regular_details||'{\"deliveryMethod\":\"delivery\"}' WHERE id=$1",[request.id]);
 await assert.rejects(()=>previewPickupStockTransfers(request.id,input,context,deps),{code:'REGULAR_PICKUP_REQUIRED'});
});

test('unclaimed old pickup approval returns to SCM queue, can reject, and a completed request cannot be converted again',async()=>{
 let request=await create();
 await query("UPDATE sales_stock_request_lines SET status='approved',regular_decision='stock' WHERE request_id=$1",[request.id]);
 await query("UPDATE sales_stock_requests SET regular_details=regular_details||'{\"approvalExpiresAt\":\"2000-01-01T00:00:00Z\"}' WHERE id=$1",[request.id]);
 assert((await listScmStockRequests({queue:'request',limit:100})).some(row=>row.id===request.id));
 assert(!(await listScmStockRequests({queue:'approved',limit:100})).some(row=>row.id===request.id));
 request=await decideRegularStockRequest(request.id,{expectedRevision:request.revision,lineIds:[request.lines[0].id],decision:'reject',reason:'Not needed'},context,deps);
 await assert.rejects(()=>previewPickupStockTransfers(request.id,draft(request),context,deps),/no items available/);
 assert.equal(request.status,'completed');
});

test('unconfirmed external result stays recoverable and failed refresh or revision race cannot change the draft',async()=>{
 let request=await create(),input=draft(request);
 const preview=await previewPickupStockTransfers(request.id,input,context,deps);
 await assert.rejects(()=>convertPickupStockTransfers(request.id,{...input,confirmationToken:preview.confirmationToken},context,{...deps,confirmTransfer:async()=>{}}),{code:'REGULAR_PICKUP_UNCONFIRMED'});
 assert.equal((await getScmStockRequest(request.id)).regular.pickupTransfer.status,'attention');
 const transfer=(await getScmStockRequest(request.id)).transfers[0];
 await assert.rejects(()=>reviseStockTransferQuantities(transfer.id,{expectedRevision:transfer.revision,requestId:'change-frozen-pallets',palletQuantity:999},context),{code:'REGULAR_PICKUP_LOCKED'});
 request=await create();input=draft(request);
 await assert.rejects(()=>previewPickupStockTransfers(request.id,input,context,{...deps,refreshAvailability:async()=>{throw Error('Inventory unavailable');}}),/Inventory unavailable/);
 const reviewed=await previewPickupStockTransfers(request.id,input,context,deps);
 await assert.rejects(()=>convertPickupStockTransfers(request.id,{...input,confirmationToken:reviewed.confirmationToken},context,{...deps,refreshAvailability:async()=>{await query('UPDATE sales_stock_requests SET revision=revision+1 WHERE id=$1',[request.id]);}}),{code:'STOCK_REQUEST_REVISION_CONFLICT'});
 const unchanged=await getScmStockRequest(request.id);assert.equal(unchanged.lines[0].salesQty,10);assert.equal(unchanged.transfers.length,0);
});
