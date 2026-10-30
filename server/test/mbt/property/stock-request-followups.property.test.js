import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {requestCheckQuantity} from '../../../src/stock-check/request-quantity.js';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {submitRegularStockRequest,decideRegularStockRequest} from '../../../src/regular-stock-request-service.js';
import {createStockCheckRepository} from '../../../src/stock-check/repository.js';
import {createRequestStockChecks} from '../../../src/stock-check/request-checks.js';

test('pallet conversion covers both exact quantities and the next partial pallet without rounding down',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:999}),fc.integer({min:1,max:9999}),(pallets,units)=>{
  const conversion=units/100;
  const row={requested_quantity:Number((pallets*conversion).toFixed(6)),requested_uom:'SQFT',inventory_unit:'SQFT',inventory_to_plt:conversion};
  assert.equal(requestCheckQuantity(row).checkQuantity,pallets);
  assert.equal(requestCheckQuantity({...row,scm_reviewed_quantity:Number(((pallets+.25)*conversion).toFixed(6))}).checkQuantity,pallets+1);
  assert.equal(requestCheckQuantity({...row,inventory_to_plt:null}).checkQuantity,null);
 }),{seed:27102026,numRuns:200});
 for(const uom of ['PLT','pallet','BNDL'])assert.equal(requestCheckQuantity({requested_quantity:20.1,requested_uom:uom}).checkQuantity,21);
 assert.equal(requestCheckQuantity({requested_quantity:1046.2,requested_uom:'SQFT',pack_pallet_qty:20}).checkQuantity,20);
 assert.equal(requestCheckQuantity({requested_quantity:1046.2,requested_uom:'SQFT',pack_pallet_qty:20,pack_layer_qty:1}).checkQuantity,null);
});

test('generated request decisions preserve expiry, per-line completion, SO acceptance and checked quantity',async()=>{
 const itemId=985719,f=await fixture({sku:itemId}),ids=[];
 const scm={operatorId:f.users.scm.id},context={operatorId:f.users.sales.id,authorizedDestinationLocationIds:[1],allowOverAvailability:true};
 const deps={refreshAvailability:async()=>{},loadPolicies:async()=>[{itemId,sourceLocationId:28,availableQuantity:1e6,safetyQuantity:0}]};
 const repo=createStockCheckRepository({credentialKey:async()=>Buffer.alloc(32,7)}),checks=createRequestStockChecks(repo);
 try{
  await f.query('UPDATE scm_smart_settings SET regular_stock_auto_approval_enabled=true WHERE id=1');
  await f.query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,28,'2967',1000000,1000000,now())",[itemId]);
  const product=await repo.upsertScrapedProduct(1,{sku:'PROPERTY-URBAN',name:'Urban',colour:'Buff',size:'18x36',pickupLocation:'Ayr',url:'https://ontario.order.unilock.com/products/products/urban?child=PROPERTY-URBAN'});
  await repo.saveAccount(1,{label:'Fixture',username:'fixture',password:'fixture'},scm.operatorId);
  await fc.assert(fc.asyncProperty(fc.integer({min:2,max:50}),fc.integer({min:1,max:3}),async(q,count)=>{
   let r=await submitRegularStockRequest({deliveryMethod:'pickup',destinationLocationId:1,lines:Array.from({length:count},()=>({itemId,sourceLocationId:28,salesQty:q}))},context,deps);ids.push(r.id);
   await f.query("UPDATE sales_stock_requests SET regular_details=regular_details||'{\"approvalExpiresAt\":\"2000-01-01T00:00:00Z\"}' WHERE id=$1",[r.id]);
   r=await decideRegularStockRequest(r.id,{expectedRevision:r.revision,lineIds:[r.lines[0].id],decision:'reject',reason:'Expired'},scm,deps);
   assert.equal(r.lines[0].status,'rejected');assert.equal(r.regular.approvalExpiresAt,'2000-01-01T00:00:00Z');
   let stock=await submitRegularStockRequest({deliveryMethod:'stocking',destinationLocationId:1,lines:Array.from({length:count},()=>({itemId,sourceLocationId:28,salesQty:q}))},context,deps);ids.push(stock.id);
   stock=await decideRegularStockRequest(stock.id,{expectedRevision:stock.revision,lineIds:stock.lines.map(l=>l.id),decision:'yard_stock'},scm,deps);
   assert.equal(stock.statusSummary.status,'completed');assert(stock.lines.every(l=>l.yardStock&&l.status==='closed'));assert.deepEqual(stock.transfers,[]);
   let back=await f.create(count);for(let i=0;i<count;i++)back=await f.review(back,i);
   back=await f.action(back,'sales','already-ordered/sales-order',{salesOrderRef:'SO-GENERATED-'+back.id});assert(back.lines.every(l=>l.salesDecision==='accepted'));
   await f.query("UPDATE sales_special_stock_lines SET requested_quantity=$2,scm_reviewed_quantity=NULL,requested_uom='PLT',brand='Unilock',response_vendor_name='Unilock' WHERE request_id=$1",[back.id,q]);
   const data=await checks.get(back.id),saved=await checks.start(back.id,{lines:data.lines.map(l=>({lineId:l.lineId,productId:product.id,fingerprint:l.fingerprint}))},scm.operatorId);
   assert(saved.lines.every(l=>l.job.payload.quantity===q));
   await f.query("UPDATE scm_stock_check_jobs SET status='cancelled' WHERE payload->'requestLine'->>'requestId'=$1",[String(back.id)]);
  }),{seed:27102026,numRuns:8,endOnFailure:true});
 }finally{await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[ids]);await f.close();}
});
