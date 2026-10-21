/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {readSpecialRestOrder} from '../../../src/special-stock-rest-orders.js';
import {prepareSpecialFulfillmentPlan,applySpecialFulfillmentPlan} from '../../../src/special-stock-fulfillment-adapter.js';
function fixture(){
 const record={id:'10',entity:{id:'20'},location:{id:'1'},custbody3:{id:'1'},custbody7:'',discountItem:{id:'10716'},discountRate:-4,
 item:{items:[{line:1,item:{id:'2055'},quantity:2,units:'1',rate:10,description:'TEST material',location:{id:'1'}}]}};
 const state={record,patches:[],fail:false};
 const boundary={config:{pickupMethodId:'1',deliveryMethodId:'2'},queryAll:async()=>[{uniquekey:101,rest_line_id:1,item:2055,status:'B',execution_quantity:0,billed_quantity:0,line_closed:'F'}],
 rest:async(path,options={})=>{assert.match(path,/^\/record\/v1\/salesOrder\/10/);if(options.method==='PATCH'){state.patches.push(options.body);Object.assign(record,options.body);if(state.fail){state.fail=false;throw Error('Lost acknowledgement');}}return {data:structuredClone(record)};}};
 return {boundary,state};
}
test('delivery REST changes only fulfillment headers, survives lost acknowledgement and never repeats PATCH',async()=>{
 const {boundary,state}=fixture();const plan=await prepareSpecialFulfillmentPlan({salesOrderId:10,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST site',deliveryDate:'2099-02-01',deliveryContactName:'Name'},boundary);
 state.fail=true;await assert.rejects(()=>applySpecialFulfillmentPlan(plan,boundary),/Lost acknowledgement/);
 const result=await applySpecialFulfillmentPlan(plan,boundary);assert.equal(result.deliveryMethodId,2);assert.equal(state.patches.length,1);
 assert.deepEqual(Object.keys(state.patches[0]).sort(),['custbody3','custbody4','custbody7','shipOverride','shippingAddress']);assert.equal(state.record.item.items[0].rate,10);assert.equal(state.record.discountRate,-4);
});
test('pickup clears obsolete delivery notes/date while retaining unused shipping address',async()=>{
 const {boundary,state}=fixture();Object.assign(state.record,{custbody3:{id:'2'},custbody4:'2099-02-01',custbody7:'Old delivery',shippingAddress:{addrText:'Old site'}});
 const plan=await prepareSpecialFulfillmentPlan({salesOrderId:10,fulfillmentMethod:'vendor_pickup'},boundary);await applySpecialFulfillmentPlan(plan,boundary);
 assert.equal(state.record.custbody4,null);assert.equal(state.record.custbody7,null);assert.equal(state.record.shippingAddress.addrText,'Old site');
});
test('property: unrelated remote rate changes reject before PATCH',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:11,max:99999}),async rate=>{
 const {boundary,state}=fixture();const plan=await prepareSpecialFulfillmentPlan({salesOrderId:10,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST site'},boundary);state.record.item.items[0].rate=rate;
 await assert.rejects(()=>applySpecialFulfillmentPlan(plan,boundary),{code:'SPECIAL_FULFILLMENT_CONFLICT'});assert.equal(state.patches.length,0);
 }),{numRuns:30});
});
test('third-party delivery edits and invalid method mappings reject without overwriting',async()=>{
 const {boundary,state}=fixture();const plan=await prepareSpecialFulfillmentPlan({salesOrderId:10,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST site'},boundary);state.record.custbody7='Manual edit';
 await assert.rejects(()=>applySpecialFulfillmentPlan(plan,boundary),{code:'SPECIAL_FULFILLMENT_CONFLICT'});assert.equal(state.patches.length,0);
 boundary.config.pickupMethodId='';await assert.rejects(()=>prepareSpecialFulfillmentPlan({salesOrderId:10,fulfillmentMethod:'vendor_pickup'},boundary));
});
test('default NetSuite wrappers use the configured delivery mapping and serialized REST mutation',async()=>{
 const {prepareSpecialFulfillmentInNetSuite,applySpecialFulfillmentInNetSuite}=await import('../../../src/netsuite.js');
 const {boundary,state}=fixture();let mutations=0;
 const plan=await prepareSpecialFulfillmentInNetSuite({salesOrderId:10,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST site'},{rest:boundary.rest,queryAll:boundary.queryAll});
 assert.equal(plan.target.methodId,2);
 const verified=await applySpecialFulfillmentInNetSuite(plan,{...boundary,mutate:async action=>{mutations++;return action();}});
 assert.equal(verified.deliveryMethodId,2);assert.equal(state.patches.length,1);assert.equal(mutations,1);
});
test('delivery header accepts the separate native order discount row without changing commercial data',async()=>{
 const {boundary,state}=fixture(),original=boundary.queryAll;
 boundary.queryAll=async()=>[...await original(),{uniquekey:131,rest_line_id:31,item:10716,status:'B',execution_quantity:0,billed_quantity:0,line_closed:'F'}];
 const before=structuredClone(state.record.item);
 const plan=await prepareSpecialFulfillmentPlan({salesOrderId:10,fulfillmentMethod:'mbt_delivery',deliveryAddress:'New site'},boundary);
 await applySpecialFulfillmentPlan(plan,boundary);
 assert.equal(state.patches.length,1);assert.deepEqual(state.record.item,before);
 assert.equal(state.record.discountRate,-4);assert.equal(state.record.discountItem.id,'10716');
 assert.ok(state.patches.every(patch=>!Object.hasOwn(patch,'item')&&!Object.hasOwn(patch,'discountItem')&&!Object.hasOwn(patch,'discountRate')));
});
test('property: only one matching header discount may be outside the material sublist',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:102,max:100000}),fc.integer({min:2,max:100}),async(key,line)=>{
  const {boundary,state}=fixture(),original=boundary.queryAll;
  const row={uniquekey:key,rest_line_id:line,item:10716,status:'B',execution_quantity:0,billed_quantity:0,line_closed:'F'};
  boundary.queryAll=async()=>[...await original(),row];
  assert.ok(await prepareSpecialFulfillmentPlan({salesOrderId:10,fulfillmentMethod:'vendor_pickup'},boundary));
  await assert.rejects(readSpecialRestOrder({id:10,kind:'sales_order'},boundary),{code:'SPECIAL_ADJUSTMENT_CONFLICT'});
  for(const extras of [[{...row,item:2055}],[row,{...row,uniquekey:key+1,rest_line_id:line+1}],[{...row,uniquekey:101}]]){
   boundary.queryAll=async()=>[...await original(),...extras];
   await assert.rejects(()=>prepareSpecialFulfillmentPlan({salesOrderId:10,fulfillmentMethod:'vendor_pickup'},boundary));
  }
  assert.equal(state.patches.length,0);
 }),{seed:631017,numRuns:40});
});
