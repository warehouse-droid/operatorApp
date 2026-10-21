import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {evaluateRegularStockApproval,regularReplenishmentQuantity,planRegularStockRouting} from '../../../src/regular-stock-domain.js';
import {normalizeRegularArrival} from '../../../public/regular-stock-input.js';
const config={numRuns:250,seed:29673445};
test('approval is exactly the conjunction of aggregated safety and configurable lead time',()=>{
 fc.assert(fc.property(fc.integer({min:0,max:100000}),fc.integer({min:0,max:100000}),fc.integer({min:1,max:10000}),fc.integer({min:1,max:10000}),fc.integer({min:0,max:100}),fc.integer({min:0,max:101}), (available,safety,a,b,hours,arrivalHours)=>{
  const result=evaluateRegularStockApproval({lines:[a,b].map((qty,index)=>({id:index+1,itemId:10,sourceLocationId:1,salesQty:qty})),policies:[{itemId:10,sourceLocationId:1,availableQuantity:available,safetyQuantity:safety}],now:new Date(0),arrivalAt:new Date(arrivalHours*3600000),leadHours:hours});
  assert.equal(result.automatic,available-a-b>=safety&&arrivalHours>=hours);
  assert.equal(result.lines[0].remainingQuantity,available-a-b);
  const equality=evaluateRegularStockApproval({lines:[{id:1,itemId:10,sourceLocationId:1,salesQty:a+b}],policies:[{itemId:10,sourceLocationId:1,availableQuantity:safety+a+b,safetyQuantity:safety}],now:new Date(0),arrivalAt:new Date(hours*3600000),leadHours:hours});
  assert.equal(equality.automatic,true);
 }),config);
});
test('preferred replenishment is the smallest nonnegative purchasing increment that covers the gap',()=>{
 fc.assert(fc.property(fc.integer({min:0,max:100000}),fc.integer({min:-1000,max:100000}),fc.integer({min:1,max:100}), (preferred,position,increment)=>{
  const quantity=regularReplenishmentQuantity({preferredQuantity:preferred,inventoryPositionQuantity:position,purchaseIncrement:increment});
  assert.equal(quantity%increment,0);assert(quantity>=Math.max(0,preferred-position));
  assert(quantity===0||quantity-increment<preferred-position);
 }),config);
});
test('Toronto daytime text round-trips in both winter and summer',()=>{
 fc.assert(fc.property(fc.integer({min:2025,max:2035}),fc.integer({min:1,max:12}),fc.integer({min:1,max:28}),fc.integer({min:4,max:23}),fc.integer({min:0,max:59}),(year,month,day,hour,minute)=>{
  const input=normalizeRegularArrival(`${month}/${day}/${year}`,`${hour}:${String(minute).padStart(2,'0')}`);
  assert.deepEqual(normalizeRegularArrival(input.date,input.time),input);
  const formatted=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(input.arrivalAt));
  const parts=Object.fromEntries(formatted.map(p=>[p.type,p.value]));assert.equal(Number(parts.hour),hour);assert.equal(Number(parts.day),day);
 }),{...config,numRuns:100});
});
test('SO routing conserves approved quantity across split material rows',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:10000}),fc.integer({min:1,max:10000}),fc.boolean(),(a,b,extra)=>{
  const lines=[{id:1,itemId:10,sourceLocationId:1,salesQty:a+b,salesUom:'EA',decision:'stock'}];
  const material=(id,qty,itemId=10)=>({remoteLineId:id,itemId,quantity:qty,uom:'EA',open:true,locationId:28});
  const plan=planRegularStockRouting({request:{destinationLocationId:28,lines},salesOrder:{locationId:28,lines:[material(11,a),material(12,b),...(extra?[material(13,1,42)]:[])]}});
  assert.equal(plan.mappings.reduce((sum,row)=>sum+row.quantity,0),a+b);assert.equal(plan.mode,extra?'transfer':'location');
 }),config);
});
