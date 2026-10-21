import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {readRegularSalesOrder} from '../../../src/regular-stock-netsuite-adapter.js';
import {submitDeliveryStockRequest,retryDeliveryStockRequest,previewDeliveryStockRequest} from '../../../src/regular-stock-delivery.js';
import {kitFixture} from '../fixtures/regular-stock-kit.js';

const actor='remaining-'+randomUUID(),itemId=9700000000000+parseInt(randomUUID().slice(0,8),16);
const context={operatorId:actor,authorizedDestinationLocationIds:[1,28]};
let sequence=0;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true)",[actor]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'Remaining material','PC',1,100)",[itemId]);
  await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',10000,10000,now())",[itemId]);
});
after(closeDb);
function fixture() {
  const f=kitFixture(),id=itemId+(++sequence),ref=`SO-${actor}-${sequence}`;
  for(const row of f.rows)Object.assign(row,{id,tranid:ref,status:'D'});
  Object.assign(f.rows[0],{item_id:itemId,quantity:-100,fulfilled_quantity:40,billed_quantity:100,backordered_quantity:20});
  const rest=f.boundary.rest;
  f.boundary.rest=async(...args)=>{const result=await rest(...args);result.data.id=id;result.data.tranId=ref;return result;};
  const calls={transfers:0};
  const dependencies={liveExecutionEnabled:true,readOrder:()=>readRegularSalesOrder(ref,f.boundary),hydrateOrder:async()=>{},refreshAvailability:async()=>{},syncReplenishments:async()=>{},linkTransferDependency:async()=>{},
    confirmTransfer:async transfer=>{
      calls.transfers++;
      assert.deepEqual(transfer.lines.map(line=>line.salesQty),[60]);
      await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete',status='pending_fulfillment' WHERE id=$1",[transfer.id,9500000+transfer.id,`TO-${transfer.id}`]);
    }};
  return {...f,calls,dependencies,input:{sourceLocationId:1,destinationLocationId:28,salesOrderRef:ref}};
}
test('billed partial SO previews and creates only the remaining transfer, once',async()=>{
  const f=fixture(),preview=await previewDeliveryStockRequest(f.input,context,f.dependencies);
  assert.deepEqual(preview.lines.map(line=>line.salesQty),[60]);
  const request=await submitDeliveryStockRequest(f.input,context,f.dependencies);
  assert.equal(request.regular.handoffStatus,'complete');assert.equal(f.calls.transfers,1);
  assert.deepEqual(request.lines.map(line=>line.salesQty),[60]);
  const retry=await retryDeliveryStockRequest(request.id,context,f.dependencies);
  assert.equal(retry.id,request.id);assert.equal(f.calls.transfers,1);
});
test('fulfillment or closure after approval blocks a stale transfer without a remote write',async()=>{
  for(const change of [row=>{row.fulfilled_quantity=41;},row=>{row.line_closed='T';}]) {
    const f=fixture(),saved=await submitDeliveryStockRequest(f.input,context,{...f.dependencies,liveExecutionEnabled:false});
    assert.equal(saved.regular.handoffStatus,'attention');change(f.rows[0]);
    const retry=await retryDeliveryStockRequest(saved.id,context,f.dependencies);
    assert.equal(retry.regular.handoffStatus,'attention');assert.match(retry.regular.handoffError,/SO changed/);
    assert.equal(f.calls.transfers,0);
  }
});
test('billing-only activity after approval still permits the saved remaining transfer',async()=>{
  const f=fixture(),saved=await submitDeliveryStockRequest(f.input,context,{...f.dependencies,liveExecutionEnabled:false});
  f.rows[0].billed_quantity=50;
  const retry=await retryDeliveryStockRequest(saved.id,context,f.dependencies);
  assert.equal(retry.regular.handoffStatus,'complete');assert.equal(f.calls.transfers,1);
});
