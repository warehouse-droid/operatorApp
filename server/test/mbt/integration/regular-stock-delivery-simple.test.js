import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {submitDeliveryStockRequest,decideDeliveryStockRequest,retryDeliveryStockRequest} from '../../../src/regular-stock-delivery.js';
import {getScmStockRequest,cancelSalesStockRequest,updateScmStockRequestLine,listScmStockRequests} from '../../../src/stock-request-repository.js';
import {linkRegularStockSalesOrder} from '../../../src/regular-stock-handoff.js';
const actor='delivery-simple-'+randomUUID(),itemId=9800000000120;
const context={operatorId:actor,authorizedDestinationLocationIds:[1,28,15,26]};
let sequence=0;
const baseId=parseInt(randomUUID().replaceAll('-','').slice(0,10),16);
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true)",[actor]);
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'DELIVERY-SIMPLE-MATERIAL','EA',1,100) ON CONFLICT DO NOTHING",[itemId]);
 for(const id of [1,28,15,26])await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,100000000,100000000,now()) ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_available=100000000,quantity_on_hand=100000000",[itemId,id,String(id)]);
});
after(closeDb);
function fixture(from=1,to=28){
 const id=baseId+(++sequence),ref=`SO-DELIVERY-${actor}-${sequence}`;
 const order={id,ref,customerId:42,locationId:to,lines:[{remoteLineId:1,itemId,quantity:200,backorderedQuantity:20,uom:'EA',locationId:to,open:true},{remoteLineId:2,itemId:-2,ancillary:true,quantity:null,locationId:to}]};
 const calls={reads:0,confirm:0,location:0,dependencies:0};
 const dependencies={liveExecutionEnabled:true,readOrder:async()=>{calls.reads++;return structuredClone(order);},refreshAvailability:async()=>{},hydrateOrder:async()=>{},syncReplenishments:async()=>{},applyLocation:async()=>{calls.location++;},linkTransferDependency:async()=>{calls.dependencies++;},confirmTransfer:async transfer=>{
  calls.confirm++;await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete',status='pending_fulfillment' WHERE id=$1",[transfer.id,9300000+transfer.id,`TO-DELIVERY-${transfer.id}`]);
 }};
 return {input:{deliveryMethod:'delivery',sourceLocationId:from,destinationLocationId:to,salesOrderRef:ref},dependencies,calls,order};
}
test('both automatic routes submit only three fields, issue a TO from SO quantities, and reuse duplicate submissions',async()=>{
 for(const [from,to] of [[1,28],[28,1]]){
  const f=fixture(from,to),request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
  assert.equal(request.regular.approval.automatic,true);assert.equal(request.regular.handoffStatus,'complete');
  assert.equal(request.regular.routingMode,'transfer');assert.equal(request.lines[0].salesQty,200);assert.equal(request.transfers.length,1);
  assert.equal(request.transfers[0].sourceLocationId,from);assert.equal(request.transfers[0].destinationLocationId,to);
  assert.equal(f.calls.location,0);assert.equal(f.calls.confirm,1);assert.equal(f.calls.dependencies,1);
  const duplicate=await submitDeliveryStockRequest({...f.input,salesOrderRef:f.input.salesOrderRef.toLowerCase()},context,f.dependencies);
  assert.equal(duplicate.id,request.id);assert.equal(f.calls.confirm,1);
 }
});
test('all routes involving 150 or 12441 require whole-request manual approval before transfer creation',async()=>{
 for(const from of [1,28,15,26])for(const to of [1,28,15,26]){
  if(from===to||([1,28].includes(from)&&[1,28].includes(to)))continue;
  const f=fixture(from,to),request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
  assert.equal(request.regular.approval.automatic,false);assert.equal(request.lines[0].status,'submitted');assert.equal(request.transfers.length,0);assert.equal(f.calls.confirm,0);
  await assert.rejects(()=>retryDeliveryStockRequest(request.id,context,f.dependencies),{code:'REGULAR_APPROVAL_REQUIRED'});
  await assert.rejects(()=>linkRegularStockSalesOrder(request.id,{salesOrderRef:f.input.salesOrderRef},context,f.dependencies),{code:'REGULAR_APPROVAL_REQUIRED'});
  const approved=await decideDeliveryStockRequest(request.id,{decision:'stock',expectedRevision:request.revision,lineIds:request.lines.map(line=>line.id)},context,f.dependencies);
  assert.equal(approved.regular.handoffStatus,'complete');assert.equal(approved.manualDecisionEventId>0,true);assert.equal(f.calls.confirm,1);
 }
});
test('access, same-yard, blank SO, wrong SO location and client quantities fail before writes',async()=>{
 const f=fixture();
 await assert.rejects(()=>submitDeliveryStockRequest({...f.input,destinationLocationId:26},{...context,authorizedDestinationLocationIds:[15]},f.dependencies),{status:403});
 assert.equal(f.calls.reads,0);
 for(const change of [{sourceLocationId:28},{salesOrderRef:''},{lines:[{itemId,salesQty:999}]}])await assert.rejects(()=>submitDeliveryStockRequest({...f.input,...change},context,f.dependencies));
 f.order.lines[0].locationId=1;await assert.rejects(()=>submitDeliveryStockRequest(f.input,context,f.dependencies),{code:'REGULAR_SO_MISMATCH'});assert.equal(f.calls.confirm,0);
});
test('rejection creates neither TO nor print, and cannot be bypassed by retry',async()=>{
 const f=fixture(15),request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
 await assert.rejects(()=>decideDeliveryStockRequest(request.id,{decision:'po',expectedRevision:request.revision},context,f.dependencies));
 const rejected=await decideDeliveryStockRequest(request.id,{decision:'reject',reason:'Not required',expectedRevision:request.revision},context,f.dependencies);
 assert.equal(rejected.lines[0].status,'rejected');assert.equal(f.calls.confirm,0);
 await assert.rejects(()=>retryDeliveryStockRequest(request.id,context,f.dependencies),{code:'REGULAR_APPROVAL_REQUIRED'});
});
test('stale SO on manual approval stops execution and retains visible recovery state',async()=>{
 const f=fixture(26),request=await submitDeliveryStockRequest(f.input,context,f.dependencies);f.order.lines[0].quantity=201;
 const result=await decideDeliveryStockRequest(request.id,{decision:'stock',expectedRevision:request.revision},context,f.dependencies);
 assert.equal(result.regular.handoffStatus,'attention');assert.match(result.regular.handoffError,/changed/i);assert.equal(f.calls.confirm,0);
 f.order.lines[0].quantity=200;
 const done=await retryDeliveryStockRequest(request.id,context,f.dependencies);assert.equal(done.regular.handoffStatus,'complete');assert.equal(f.calls.confirm,1);
});
test('simultaneous submissions and retries preserve one request and one transfer',async()=>{
 const f=fixture();let entered,release;
 const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const confirm=f.dependencies.confirmTransfer;
 f.dependencies.confirmTransfer=async transfer=>{entered();await gate;return confirm(transfer);};
 const first=submitDeliveryStockRequest(f.input,context,f.dependencies);await Promise.race([started,first]);
 try{
  const second=await submitDeliveryStockRequest(f.input,context,f.dependencies);assert.equal(second.transfers.length,1);
 }finally{release();}
 const done=await first;assert.equal(f.calls.confirm,1);
 assert.equal((await getScmStockRequest(done.id)).transfers.length,1);
});
test('a failed printer after remote commitment retries the existing transfer without hiding the failure',async()=>{
 const f=fixture();let attempts=0;
 const confirm=f.dependencies.confirmTransfer;
 f.dependencies.confirmTransfer=async transfer=>{
  if(++attempts===1){await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='attention',status='pending_fulfillment' WHERE id=$1",[transfer.id,9400000+transfer.id,`TO-PRINT-${transfer.id}`]);throw Error('Printer unavailable');}
  return confirm(transfer);
 };
 const request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
 assert.equal(request.regular.handoffStatus,'attention');assert.match(request.regular.handoffError,/Printer unavailable/);
 assert.equal(f.calls.dependencies,1,'The committed TO remains linked to the SO while printing is retried');
 const remote=request.transfers[0].netsuiteTransferOrderId;
 f.dependencies.confirmTransfer=async transfer=>{assert.equal(transfer.netsuiteTransferOrderId,remote);await query("UPDATE sales_stock_transfers SET confirmation_status='complete' WHERE id=$1",[transfer.id]);};
 const done=await retryDeliveryStockRequest(request.id,context,f.dependencies);
 assert.equal(done.regular.handoffStatus,'complete');assert.equal(done.transfers[0].id,request.transfers[0].id);assert.equal(done.transfers[0].netsuiteTransferOrderId,remote);
});
test('pending Delivery cannot be edited, and cancellation releases the unused SO for a corrected request',async()=>{
 const f=fixture(15),request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
 await assert.rejects(()=>updateScmStockRequestLine(request.id,request.lines[0].id,{expectedRevision:request.revision,pieces:1},context),{code:'REGULAR_DELIVERY_LOCKED'});
 await cancelSalesStockRequest(request.id,{expectedRevision:request.revision},context);
 await assert.rejects(()=>retryDeliveryStockRequest(request.id,context,f.dependencies),{code:'REGULAR_APPROVAL_REQUIRED'});
 const corrected=await submitDeliveryStockRequest({...f.input,sourceLocationId:1},context,f.dependencies);
 assert.notEqual(corrected.id,request.id);assert.equal(corrected.regular.handoffStatus,'complete');assert.equal(f.calls.confirm,1);
});
test('same SO cannot be submitted under a different route or requester',async()=>{
 const f=fixture(15);await submitDeliveryStockRequest(f.input,context,f.dependencies);
 await assert.rejects(()=>submitDeliveryStockRequest({...f.input,sourceLocationId:1},context,f.dependencies),{code:'REGULAR_SO_REUSED'});
 await assert.rejects(()=>submitDeliveryStockRequest(f.input,{...context,operatorId:'other'},f.dependencies),{code:'REGULAR_SO_REUSED'});
 assert.equal(f.calls.confirm,0);
});
test('a disabled execution gate keeps the saved Delivery in Pending TO with visible recovery and never asks for another SO',async()=>{
 const f=fixture(),request=await submitDeliveryStockRequest(f.input,context,{...f.dependencies,liveExecutionEnabled:false});
 assert.equal(request.regular.handoffStatus,'attention');assert.match(request.regular.handoffError,/disabled/);assert.equal(f.calls.confirm,0);
 assert((await listScmStockRequests({queue:'pending_to',limit:200})).some(row=>row.id===request.id));
 assert(!(await listScmStockRequests({queue:'approved',limit:200})).some(row=>row.id===request.id));
 const done=await retryDeliveryStockRequest(request.id,context,f.dependencies);assert.equal(done.regular.handoffStatus,'complete');assert.equal(f.calls.confirm,1);
});
test('SCM rejects stale revisions, partial or malformed selections and missing rejection reasons without a decision',async()=>{
 const f=fixture(15),request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
 const body={decision:'stock',expectedRevision:request.revision};
 await assert.rejects(()=>decideDeliveryStockRequest(request.id,{...body,expectedRevision:request.revision+1},context,f.dependencies),{code:'STOCK_REQUEST_REVISION_CONFLICT'});
 for(const lineIds of [[],[request.lines[0].id+1],'invalid'])await assert.rejects(()=>decideDeliveryStockRequest(request.id,{...body,lineIds},context,f.dependencies),{code:'REGULAR_DECISION_INVALID'});
 await assert.rejects(()=>decideDeliveryStockRequest(request.id,{...body,decision:'reject',reason:' '},context,f.dependencies),{code:'REGULAR_REASON_REQUIRED'});
 assert.equal((await getScmStockRequest(request.id)).regular.deliveryApproval,'pending');assert.equal(f.calls.confirm,0);
});
test('a missing inventory item or inconsistent SO unit cannot create a request',async()=>{
 const f=fixture();f.order.lines[0].itemId=9800000999123;
 await assert.rejects(()=>submitDeliveryStockRequest(f.input,context,f.dependencies),{code:'STOCK_REQUEST_ITEM_NOT_FOUND'});
 f.order.lines[0].itemId=itemId;f.order.lines[0].uom='BOX';
 await assert.rejects(()=>submitDeliveryStockRequest(f.input,context,f.dependencies),/SO and item master units differ/);
 assert.equal((await query('SELECT 1 FROM regular_stock_handoffs WHERE sales_order_id=$1',[f.order.id])).rowCount,0);assert.equal(f.calls.confirm,0);
});

test('whole backordered lines determine units and calculated PALLET, including repeated items and different SO header',async()=>{
 const f=fixture();f.order.locationId=15;
 f.order.lines[0].quantity=110;
 f.order.lines.push({...f.order.lines[0],remoteLineId:3,quantity:40,backorderedQuantity:1});
 f.order.lines.push({...f.order.lines[0],remoteLineId:4,quantity:500,backorderedQuantity:0});
 f.order.lines.push({remoteLineId:5,itemId:999,quantity:99,physicalPallet:true,ancillary:true});
 const request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
 assert.deepEqual(request.lines.map(line=>line.salesQty),[110,40]);
 assert.equal(request.regular.palletQuantity,2);assert.equal(request.transfers[0].palletQuantity,2);
 assert.equal(request.transfers[0].palletQuantityRequiresManual,false);
 assert.equal(request.transfers[0].palletQuantityManuallyAdjusted,false);
 assert.equal(request.regular.handoffStatus,'complete');
 const plan=(await query('SELECT plan FROM regular_stock_handoffs WHERE request_id=$1',[request.id])).rows[0].plan;
 assert.deepEqual(plan.mappings.map(line=>[line.remoteLineId,line.quantity]),[[1,110],[3,40]]);
});
test('missing pallet conversion blocks instead of inventing a PALLET count',async()=>{
 const f=fixture(15);
 await query('UPDATE inventory_items SET to_plt=NULL WHERE item_id=$1',[itemId]);
 try{await assert.rejects(()=>submitDeliveryStockRequest(f.input,context,f.dependencies),{code:'REGULAR_DELIVERY_PALLET_CONVERSION'});}
 finally{await query('UPDATE inventory_items SET to_plt=100 WHERE item_id=$1',[itemId]);}
 assert.equal(f.calls.confirm,0);
});
test('Target Yard must cover at least all backorders including repeated items',async()=>{
 const f=fixture();f.order.lines.push({...f.order.lines[0],remoteLineId:3,quantity:100,backorderedQuantity:1});
 await query('UPDATE inventory_balances SET quantity_available=19 WHERE item_id=$1 AND location_id=1',[itemId]);
 try{
  await assert.rejects(()=>submitDeliveryStockRequest(f.input,context,f.dependencies),{code:'REGULAR_DELIVERY_STOCK_SHORTAGE'});
  assert.equal((await query('SELECT 1 FROM regular_stock_handoffs WHERE sales_order_id=$1',[f.order.id])).rowCount,0);
  assert.equal(f.calls.confirm,0);
 }finally{await query('UPDATE inventory_balances SET quantity_available=100000000 WHERE item_id=$1 AND location_id=1',[itemId]);}
});
test('manual approval rechecks eligibility when a selected line no longer has a backorder',async()=>{
 const f=fixture(15),request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
 f.order.lines[0].backorderedQuantity=0;
 const saved=await decideDeliveryStockRequest(request.id,{decision:'stock',expectedRevision:request.revision},context,f.dependencies);
 assert.equal(saved.regular.handoffStatus,'attention');assert.equal(f.calls.confirm,0);
});

test('full line is preferred; otherwise transfer only backorder, and calculate PALLET from that chosen quantity',async()=>{
 for(const [available,expected,pallets] of [[1000,200,2],[199,20,1]]){
  const f=fixture();
  f.dependencies.refreshAvailability=async()=>{await query('UPDATE inventory_balances SET quantity_available=$2 WHERE item_id=$1 AND location_id=1',[itemId,available+Number((await query("SELECT COALESCE(sum(reserved_sales_quantity),0) AS n FROM sales_stock_transfer_reservations WHERE item_id=$1 AND source_location_id=1 AND status='active'",[itemId])).rows[0].n)]);};
  const request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
  assert.equal(request.regular.handoffStatus,'complete');assert.equal(request.lines[0].salesQty,expected);
  assert.equal(request.transfers[0].palletQuantity,pallets);
 }
 await query('UPDATE inventory_balances SET quantity_available=100000000 WHERE item_id=$1 AND location_id=1',[itemId]);
});

test('separate SOs cannot consume the same Target Yard stock while creation is in flight',async()=>{
 const a=fixture(),b=fixture();let entered,release;
 const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const confirm=a.dependencies.confirmTransfer;
 a.dependencies.confirmTransfer=async transfer=>{entered();await gate;return confirm(transfer);};
 const first=submitDeliveryStockRequest(a.input,context,a.dependencies);await Promise.race([started,first]);
 let second;
 try{
  second=await submitDeliveryStockRequest(b.input,context,b.dependencies);
  assert.equal(b.calls.confirm,0);assert.equal(second.regular.handoffStatus,'attention');
 }finally{release();await first;}
 assert.equal((await retryDeliveryStockRequest(second.id,context,b.dependencies)).regular.handoffStatus,'complete');
 assert.equal(b.calls.confirm,1);
});
test('stock drop before SCM approval recalculates a whole line to backorder-only with the matching PALLET quantity',async()=>{
 const f=fixture(15),pending=await submitDeliveryStockRequest(f.input,context,f.dependencies);
 assert.equal(pending.lines[0].salesQty,200);assert.equal(pending.regular.palletQuantity,2);
 await query('UPDATE inventory_balances SET quantity_available=30 WHERE item_id=$1 AND location_id=15',[itemId]);
 try{
  const saved=await decideDeliveryStockRequest(pending.id,{expectedRevision:pending.revision,decision:'stock'},context,f.dependencies);
  assert.equal(saved.lines[0].salesQty,20);assert.equal(saved.regular.palletQuantity,1);
  assert.equal(saved.transfers[0].palletQuantity,1);assert.equal(saved.regular.handoffStatus,'complete');
 }finally{await query('UPDATE inventory_balances SET quantity_available=100000000 WHERE item_id=$1 AND location_id=15',[itemId]);}
});
