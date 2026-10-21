/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { prepareSpecialAdjustmentPlan, applySpecialAdjustmentPlan } from '../../../src/special-stock-adjustment-adapter.js';
const line=(remoteLineId,itemId,quantity,rate,description)=>({remoteLineId,itemId,quantity,rate:String(rate),description,
  unitId:itemId===10716?null:itemId===1784?246:865,locationId:1,taxCode:'13',createdPoId:null,createPo:''});
function fixture(){
 const state=new Map([[11,{header:{entityId:1},lines:[line(101,2055,24,9,'A'),line(102,2055,10,20,'B'),line(103,1784,2,40,'PALLET')]}],
  [12,{header:{entityId:2},lines:[line(201,2055,24,4,'A'),line(202,2055,10,6,'B')]}]]);
 const writes=[];let fail=false;
 const boundary={snapshot:async order=>structuredClone(state.get(order.id)),apply:async order=>{
  if(order.id===12&&fail){fail=false;throw Error('PO unavailable');}
  writes.push(order.id);state.set(order.id,structuredClone(order.target));
  for(const [i,x]of state.get(order.id).lines.entries())x.remoteLineId??=900+i;
 }};
 const orders=[{id:11,kind:'sales_order',lines:[{...line(101,2055,24,9,'A'),rate:9,toQuantity:36,toRate:10,toNativeDiscountPercent:25,nativeDiscountPercent:null}],pallets:{fromQuantity:2,toQuantity:0,rate:40}},
 {id:12,kind:'purchase_order',lines:[{...line(201,2055,24,4,'A'),rate:4,toQuantity:36}]}];
 return {state,writes,boundary,orders,failNextPo(){fail=true;}};
}
test('plan inserts the discount after its material, removes PALLET, and keeps PO costs and other lines',async()=>{
 const f=fixture(),plan=await prepareSpecialAdjustmentPlan({orders:f.orders},f.boundary);
 assert.equal(plan.version,2);assert.equal(f.writes.length,0);
 assert.deepEqual(plan.orders[0].target.lines.map(x=>[x.itemId,x.quantity,x.rate]),[[2055,36,'10'],[10716,null,'-90'],[2055,10,'20']]);
 assert.deepEqual(plan.orders[1].target.lines.map(x=>[x.itemId,x.quantity,x.rate]),[[2055,36,'4'],[2055,10,'6']]);
});
test('partial success recovers without duplicate discount or another SO write',async()=>{
 const f=fixture(),plan=await prepareSpecialAdjustmentPlan({orders:f.orders},f.boundary);f.failNextPo();
 await assert.rejects(()=>applySpecialAdjustmentPlan(plan,f.boundary),/PO unavailable/);
 const result=await applySpecialAdjustmentPlan(plan,f.boundary);
 assert.deepEqual(f.writes,[11,12]);assert.deepEqual(result.verifiedOrderIds,[11,12]);
 assert.equal(result.verifiedOrders[0].lines.filter(x=>x.itemId===10716).length,1);
 await applySpecialAdjustmentPlan(plan,f.boundary);assert.deepEqual(f.writes,[11,12]);
});
test('an unrelated PO edit blocks the first SO write and stale SO prices cannot prepare',async()=>{
 const f=fixture(),plan=await prepareSpecialAdjustmentPlan({orders:f.orders},f.boundary);
 f.state.get(12).lines[1].rate='99';
 await assert.rejects(()=>applySpecialAdjustmentPlan(plan,f.boundary),{code:'SPECIAL_ADJUSTMENT_CONFLICT'});assert.deepEqual(f.writes,[]);
 f.state.get(11).lines[0].rate='8';
 await assert.rejects(()=>prepareSpecialAdjustmentPlan({orders:f.orders},f.boundary),{code:'SPECIAL_ADJUSTMENT_CONFLICT'});
});
test('property: each reviewed percentage remains adjacent to its material with original PO prices',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:1,max:10000}),fc.integer({min:1,max:500}),async(percent,quantity)=>{
  const f=fixture();f.orders[0].lines[0].toNativeDiscountPercent=percent/100;f.orders.forEach(order=>{order.lines[0].toQuantity=quantity;});
  const plan=await prepareSpecialAdjustmentPlan({orders:f.orders},f.boundary);await applySpecialAdjustmentPlan(plan,f.boundary);
  const lines=f.state.get(11).lines;
  assert.equal(lines[0].itemId,2055);assert.equal(lines[0].quantity,quantity);assert.equal(lines[0].rate,'10');
  const discountCents=(BigInt(quantity)*1000n*BigInt(percent)+5000n)/10000n;
  assert.equal(lines[1].itemId,10716);assert.equal(lines[1].rate,String(-Number(discountCents)/100));
  assert.deepEqual(f.state.get(12).lines.map(line=>line.rate),['4','6']);
 }),{numRuns:100,seed:260927});
});
test('property: any unrelated price change blocks every write',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:21,max:100000}),async(rate)=>{
  const f=fixture(),plan=await prepareSpecialAdjustmentPlan({orders:f.orders},f.boundary);
  f.state.get(12).lines[1].rate=String(rate);
  await assert.rejects(()=>applySpecialAdjustmentPlan(plan,f.boundary),{code:'SPECIAL_ADJUSTMENT_CONFLICT'});assert.deepEqual(f.writes,[]);
 }),{numRuns:60,seed:260928});
});
