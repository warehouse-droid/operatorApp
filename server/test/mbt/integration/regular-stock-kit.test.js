import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import fc from 'fast-check';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {readRegularSalesOrder} from '../../../src/regular-stock-netsuite-adapter.js';
import {submitDeliveryStockRequest,retryDeliveryStockRequest,decideDeliveryStockRequest} from '../../../src/regular-stock-delivery.js';
import {kitFixture} from '../fixtures/regular-stock-kit.js';

const actor='kit-delivery-'+randomUUID(),itemId=9800000000000+parseInt(randomUUID().replaceAll('-','').slice(0,5),16);
const context={operatorId:actor,authorizedDestinationLocationIds:[1,28,15,26]};
const baseId=parseInt(randomUUID().replaceAll('-','').slice(0,10),16);
let sequence=0;
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true)",[actor]);
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'KIT-DELIVERY-MATERIAL','PC',1,100)",[itemId]);
 for(const location of [1,28,15])await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,100000000,100000000,now())",[itemId,location,String(location)]);
});
after(closeDb);

function fixture(source=1){
 const f=kitFixture(),id=baseId+(++sequence),ref=`SO-KIT-${actor}-${sequence}`;
 for(const row of f.rows){row.id=id;row.tranid=ref;}
 f.rows[0].item_id=itemId;
 const rest=f.boundary.rest;
 f.boundary.rest=async(...args)=>{const response=await rest(...args);response.data.id=id;response.data.tranId=ref;return response;};
 const calls={confirm:0,dependencies:0};
 const dependencies={liveExecutionEnabled:true,readOrder:()=>readRegularSalesOrder(ref,f.boundary),refreshAvailability:async()=>{},
  hydrateOrder:async()=>{},syncReplenishments:async()=>{},linkTransferDependency:async()=>{calls.dependencies++;},
  confirmTransfer:async transfer=>{
   calls.confirm++;assert.deepEqual(transfer.lines.map(line=>line.itemId),[itemId]);
   await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete',status='pending_fulfillment' WHERE id=$1",
    [transfer.id,9500000+transfer.id,`TO-KIT-${transfer.id}`]);
  }};
 return {...f,calls,dependencies,input:{deliveryMethod:'delivery',sourceLocationId:source,destinationLocationId:28,salesOrderRef:ref}};
}

test('delivery with a committed kit issues only the backordered material and retries without a duplicate TO',async()=>{
 const f=fixture(),request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
 assert.equal(request.regular.handoffStatus,'complete');assert.equal(request.transfers.length,1);
 assert.deepEqual(request.lines.map(line=>[line.itemId,line.salesQty]),[[itemId,160]]);
 assert.equal(f.calls.confirm,1);assert.equal(f.calls.dependencies,1);
 const plan=(await query('SELECT plan FROM regular_stock_handoffs WHERE request_id=$1',[request.id])).rows[0].plan;
 assert.equal(plan.order.lines.find(line=>line.itemType==='Kit').kitComponents[0].quantity,16);
 const duplicate=await submitDeliveryStockRequest(f.input,context,f.dependencies);
 assert.equal(duplicate.id,request.id);assert.equal(duplicate.transfers[0].netsuiteTransferOrderRef,request.transfers[0].netsuiteTransferOrderRef);
 assert.equal(f.calls.confirm,1);
});

test('manual approval with a committed kit creates the corresponding material transfer',async()=>{
 const f=fixture(15),request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
 assert.equal(request.regular.deliveryApproval,'pending');assert.equal(f.calls.confirm,0);
 const approved=await decideDeliveryStockRequest(request.id,{decision:'stock',expectedRevision:request.revision},context,f.dependencies);
 assert.equal(approved.regular.handoffStatus,'complete');assert.equal(f.calls.confirm,1);
});

test('saved delivery retry permits changed components of an unselected kit',async()=>{
 for(const change of [
  f=>{f.components[0].quantity=-15;},f=>{f.components[0].item_id=600;},
  f=>{f.components[0].stock_unit='BOX';},f=>{f.components[0].backordered_quantity=1;},
  f=>{f.components[0].fulfilled_quantity=1;}
 ]){
  const f=fixture(),request=await submitDeliveryStockRequest(f.input,context,{...f.dependencies,liveExecutionEnabled:false});
  assert.equal(request.regular.handoffStatus,'attention');change(f);
  const retried=await retryDeliveryStockRequest(request.id,context,f.dependencies);
  assert.equal(retried.regular.handoffStatus,'complete');assert.equal(retried.regular.handoffError,null);
  assert.equal(f.calls.confirm,1);assert.equal(retried.transfers.length,1);
  assert.deepEqual(retried.transfers[0].lines.map(line=>[line.itemId,line.salesQty]),[[itemId,160]]);
 }
});

test('property: unselected kit component changes preserve the approved material transfer',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:1,max:15}),async(quantity)=>{
  const f=fixture(),request=await submitDeliveryStockRequest(f.input,context,{...f.dependencies,liveExecutionEnabled:false});
  assert.equal(request.regular.handoffStatus,'attention');
  f.components[0].quantity=-quantity;
  const result=await retryDeliveryStockRequest(request.id,context,f.dependencies);
  assert.equal(result.regular.handoffStatus,'complete');assert.equal(result.regular.handoffError,null);
  assert.equal(f.calls.confirm,1);assert.equal(result.transfers.length,1);
  assert.deepEqual(result.transfers[0].lines.map(line=>[line.itemId,line.salesQty]),[[itemId,160]]);
 }),{seed:121865,numRuns:20});
});

test('real SO SQL projection anchors hidden components to their kit parent',async()=>{
 const f=kitFixture();
 await withTransaction(async()=>{
  await query(`CREATE TEMP TABLE transaction(id bigint,tranid text,entity bigint,status text,type text);
   CREATE TEMP TABLE transactionline(transaction bigint,id bigint,uniquekey bigint,item bigint,quantity numeric,
    quantitybackordered numeric,location bigint,quantityshiprecv numeric,quantitybilled numeric,isclosed text,mainline text,taxline text,kitmemberof bigint);
   CREATE TEMP TABLE item(id bigint,stockunit bigint,itemtype text);
   CREATE SCHEMA IF NOT EXISTS builtin;
   CREATE OR REPLACE FUNCTION builtin.df(value bigint) RETURNS text LANGUAGE SQL AS $$ SELECT CASE WHEN value=118 THEN 'PC' WHEN value=246 THEN 'EACH' ELSE 'Item '||value::text END $$;
   INSERT INTO transaction VALUES(1032523,'SO-KIT',42,'B','SalesOrd');
   INSERT INTO transactionline(transaction,id,uniquekey,location,mainline,taxline) VALUES(1032523,0,5064227,1,'T','F');`);
  for(const row of f.rows){
   await query('INSERT INTO item VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[row.item_id,row.stock_unit==='PC'?118:row.stock_unit==='EACH'?246:null,row.item_type]);
   await query("INSERT INTO transactionline VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'F','F',$11)",
    [row.id,row.rest_line_id,row.line_id,row.item_id,row.quantity,row.backordered_quantity,row.location_id,row.fulfilled_quantity,row.billed_quantity,row.line_closed,row.kit_member_of]);
  }
  // Item 599 occurs both independently and in the kit; do not multiply the join.
  await query('DELETE FROM item a USING item b WHERE a.ctid>b.ctid AND a.id=b.id');
  f.boundary.queryAll=async sql=>(await query(sql.replaceAll('NVL(','COALESCE('))).rows;
  const order=await readRegularSalesOrder('SO-KIT',f.boundary);
  assert.equal(order.lines.length,4);assert.equal(order.lines[1].kitComponents.length,1);
  assert.equal(order.lines[1].kitComponents[0].itemId,599);
 },{rollback:true});
});
