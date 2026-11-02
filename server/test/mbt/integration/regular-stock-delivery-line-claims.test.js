import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {submitDeliveryStockRequest,previewDeliveryStockRequest,decideDeliveryStockRequest} from '../../../src/regular-stock-delivery.js';
import {reconcileStockRequestTransferWebhook} from '../../../src/stock-request-repository.js';

const run=randomUUID(),itemX=9800000000329,itemY=9800000000330;
const actorA='line-claims-a-'+run,actorB='line-claims-b-'+run;
const context=operatorId=>({operatorId,authorizedDestinationLocationIds:[1,28,15,26]});
let sequence=parseInt(run.replaceAll('-','').slice(0,10),16);
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  for(const id of [actorA,actorB]) await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true)",[id]);
  for(const [id,name] of [[itemX,'LINE-CLAIM-X'],[itemY,'LINE-CLAIM-Y']]) {
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,$2,'EA',1,100) ON CONFLICT DO NOTHING",[id,name]);
    for(const yard of [1,28,15,26]) await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,100000000,100000000,now()) ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_available=100000000,quantity_on_hand=100000000",[id,yard,String(yard)]);
  }
});
after(closeDb);

function fixture({source=28,lines=1}={}) {
  const id=++sequence,ref='SO-LINE-CLAIM-'+id;
  const order={id,ref,customerId:42,locationId:1,lines:Array.from({length:lines},(_,index)=>
    ({remoteLineId:index+1,itemId:itemX,quantity:100,backorderedQuantity:10,uom:'EA',locationId:1,open:true}))};
  const calls={confirm:0};
  const dependencies={liveExecutionEnabled:true,readOrder:async()=>structuredClone(order),refreshAvailability:async()=>{},hydrateOrder:async()=>{},
    syncReplenishments:async()=>{},linkTransferDependency:async()=>{},confirmTransfer:async transfer=>{
      calls.confirm++;
      await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete',status='pending_fulfillment' WHERE id=$1",
        [transfer.id,2900000000+transfer.id,'TO-CLAIM-'+transfer.id]);
    }};
  return {order,calls,dependencies,input:{deliveryMethod:'delivery',sourceLocationId:source,destinationLocationId:1,salesOrderRef:ref}};
}
const owners=async soId=>(await query(`SELECT remote_line_id,request_id,item_id,released_at,released_by_request_id,release_evidence
  FROM regular_stock_so_line_owners WHERE sales_order_id=$1 ORDER BY remote_line_id,request_id`,[soId])).rows
  .map(row=>({line:Number(row.remote_line_id),request:Number(row.request_id),item:row.item_id===null?null:Number(row.item_id),
    released:row.released_at!==null,by:row.released_by_request_id===null?null:Number(row.released_by_request_id),reason:row.release_evidence?.reason ?? null}));
async function mirrorTransfer(request,status,statusText) {
  const remote=request.transfers[0].netsuiteTransferOrderId;
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,status_updated_at,synced_at) VALUES($1,$2,$3,$4,now(),now())
    ON CONFLICT(netsuite_id) DO UPDATE SET status=EXCLUDED.status,status_text=EXCLUDED.status_text,status_updated_at=now(),synced_at=now()`,
  [remote,request.transfers[0].netsuiteTransferOrderRef,status,statusText]);
  return remote;
}
async function mirrorSalesOrderLine(order,remoteLineId,itemId) {
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active) VALUES($1,$2,'B','Pending Fulfillment',true) ON CONFLICT DO NOTHING",[order.id,order.ref]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,quantity,unit,netsuite_active) VALUES($1,$2,$3,100,'EA',true)
    ON CONFLICT(sales_order_id,line_id) DO UPDATE SET item_id=EXCLUDED.item_id`,[order.id,remoteLineId,itemId]);
}

test('SO lines left out of an earlier TO get their own TO later; only covered lines stay blocked',async()=>{
  const f=fixture({lines:4});
  const first=await submitDeliveryStockRequest({...f.input,selectedRemoteLineIds:[1,2]},context(actorA),f.dependencies);
  assert.equal(first.regular.handoffStatus,'complete');assert.equal(first.transfers.length,1);
  const preview=await previewDeliveryStockRequest(f.input,context(actorB),f.dependencies);
  assert.deepEqual(preview.candidates.map(line=>line.coveredBy?.requestRef ?? null),[first.requestRef,first.requestRef,null,null]);
  assert.deepEqual(preview.candidates[0].coveredBy.transfers.map(transfer=>transfer.status),['pending_fulfillment']);
  assert.deepEqual(preview.selectedRemoteLineIds,[3,4]);assert.equal(preview.lines.length,2);
  await assert.rejects(()=>previewDeliveryStockRequest({...f.input,selectedRemoteLineIds:[2,3]},context(actorB),f.dependencies),{code:'REGULAR_SO_REUSED'});
  await assert.rejects(()=>submitDeliveryStockRequest({...f.input,selectedRemoteLineIds:[2,3]},context(actorB),f.dependencies),
    error=>error.code==='REGULAR_SO_REUSED'&&error.message.includes(first.requestRef)&&error.message.includes('SO line 2')&&!error.message.includes('SO line 3'));
  await assert.rejects(()=>submitDeliveryStockRequest({...f.input,selectedRemoteLineIds:[1,2,3]},context(actorA),f.dependencies),{code:'REGULAR_DELIVERY_SELECTION_CONFLICT'});
  assert.equal(f.calls.confirm,1);
  const second=await submitDeliveryStockRequest({...f.input,selectedRemoteLineIds:[3,4]},context(actorB),f.dependencies);
  assert.notEqual(second.id,first.id);assert.equal(second.regular.handoffStatus,'complete');assert.equal(f.calls.confirm,2);
  assert.deepEqual(second.lines.map(line=>line.salesQty),[100,100]);
  assert.equal((await query('SELECT count(*)::int AS n FROM regular_stock_handoffs WHERE sales_order_id=$1',[f.order.id])).rows[0].n,2);
  assert.deepEqual((await owners(f.order.id)).map(row=>[row.line,row.request,row.item,row.released]),
    [[1,first.id,itemX,false],[2,first.id,itemX,false],[3,second.id,itemX,false],[4,second.id,itemX,false]]);
  // Resubmitting without a selection returns the requester's own request once every backorder is covered.
  assert.equal((await submitDeliveryStockRequest(f.input,context(actorA),f.dependencies)).id,first.id);
  assert.equal((await submitDeliveryStockRequest(f.input,context(actorB),f.dependencies)).id,second.id);
  assert.equal(f.calls.confirm,2);
});

test('a closed TO and a changed SKU release the SO line for a new TO, and the old claim keeps its history',async()=>{
  const f=fixture();
  const first=await submitDeliveryStockRequest(f.input,context(actorA),f.dependencies);
  assert.equal(first.regular.handoffStatus,'complete');
  await assert.rejects(()=>submitDeliveryStockRequest(f.input,context(actorB),f.dependencies),{code:'REGULAR_SO_REUSED'});
  const remote=await mirrorTransfer(first,'H','Closed');
  assert.equal((await reconcileStockRequestTransferWebhook({id:remote})).status,'closed');
  f.order.lines[0].itemId=itemY;await mirrorSalesOrderLine(f.order,1,itemY);
  const second=await submitDeliveryStockRequest(f.input,context(actorB),f.dependencies);
  assert.notEqual(second.id,first.id);assert.equal(second.regular.handoffStatus,'complete');
  assert.equal(second.lines[0].itemId,itemY);assert.equal(f.calls.confirm,2);
  assert.deepEqual(await owners(f.order.id),[
    {line:1,request:first.id,item:itemX,released:true,by:second.id,reason:'item_changed'},
    {line:1,request:second.id,item:itemY,released:false,by:null,reason:null}]);
  const event=(await query("SELECT details FROM sales_stock_request_events WHERE request_id=$1 AND event_type='regular_so_lines_reclaimed'",[second.id])).rows[0];
  assert.equal(event.details.lines[0].previousRequestId,first.id);
});

test('a TO closed in the webhook mirror releases the line even before the request record catches up',async()=>{
  const f=fixture();
  const first=await submitDeliveryStockRequest(f.input,context(actorA),f.dependencies);
  // Same requester and route, same SKU: an open TO makes this a resubmission of the first request.
  assert.equal((await submitDeliveryStockRequest(f.input,context(actorA),f.dependencies)).id,first.id);
  await mirrorTransfer(first,'H','Closed');
  const second=await submitDeliveryStockRequest(f.input,context(actorA),f.dependencies);
  assert.notEqual(second.id,first.id);assert.equal(second.lines[0].itemId,itemX);assert.equal(f.calls.confirm,2);
  const history=await owners(f.order.id);
  assert.deepEqual(history.map(row=>[row.request,row.released,row.reason]),[[first.id,true,'transfer_closed'],[second.id,false,null]]);
});

test('a changed SKU releases the line while the old TO is still open; the same SKU with an open TO stays blocked',async()=>{
  const f=fixture();
  const first=await submitDeliveryStockRequest(f.input,context(actorA),f.dependencies);
  await mirrorSalesOrderLine(f.order,1,itemX);
  await assert.rejects(()=>submitDeliveryStockRequest(f.input,context(actorB),f.dependencies),{code:'REGULAR_SO_REUSED'});
  f.order.lines[0].itemId=itemY;
  // The webhook has not landed yet: our DB still shows the old SKU, so the line stays blocked.
  await assert.rejects(()=>submitDeliveryStockRequest(f.input,context(actorB),f.dependencies),{code:'REGULAR_SO_REUSED'});
  await mirrorSalesOrderLine(f.order,1,itemY);
  const second=await submitDeliveryStockRequest(f.input,context(actorB),f.dependencies);
  assert.notEqual(second.id,first.id);assert.equal(second.lines[0].itemId,itemY);
});

test('a pending approval keeps the line covered and a rejection releases it',async()=>{
  const f=fixture({source:15});
  const pending=await submitDeliveryStockRequest(f.input,context(actorA),f.dependencies);
  assert.equal(pending.regular.deliveryApproval,'pending');
  await assert.rejects(()=>submitDeliveryStockRequest(f.input,context(actorB),f.dependencies),{code:'REGULAR_SO_REUSED'});
  await decideDeliveryStockRequest(pending.id,{decision:'reject',reason:'Wrong yard',expectedRevision:pending.revision},context(actorA),f.dependencies);
  const next=await submitDeliveryStockRequest(f.input,context(actorB),f.dependencies);
  assert.notEqual(next.id,pending.id);assert.equal(next.regular.deliveryApproval,'pending');
  assert.deepEqual((await owners(f.order.id)).map(row=>[row.request,row.released,row.reason]),[[pending.id,true,'request_rejected'],[next.id,false,null]]);
  assert.equal(f.calls.confirm,0);
});
