import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {deliveryRoute,deliveryMaterials,deliveryBaseYard,deliveryQuantities} from '../../../src/regular-stock-delivery-domain.js';
const yards=[1,28,15,26];
test('property: only 3445 to 2967 and its reverse auto-approve, including numeric string inputs',()=>{
 fc.assert(fc.property(fc.constantFrom(...yards),fc.constantFrom(...yards),fc.boolean(),(from,to,string)=>{
  if(from===to){assert.throws(()=>deliveryRoute(from,to),{code:'REGULAR_DELIVERY_ROUTE_INVALID'});return;}
  const route=deliveryRoute(string?String(from):from,string?String(to):to);
  assert.equal(route.automatic,(from===1&&to===28)||(from===28&&to===1));
  assert.equal(route.sourceLocationId,from);assert.equal(route.destinationLocationId,to);
 }),{seed:296729,numRuns:300});
});
test('unsupported, coerced, missing and same yards are rejected',()=>{
 for(const bad of [null,undefined,'',true,false,{},[],[1],3445,2967,150,12441,13,0,-1,1.5,Infinity,'1e0']){
  assert.throws(()=>deliveryRoute(bad,28),{code:'REGULAR_DELIVERY_ROUTE_INVALID'});
  assert.throws(()=>deliveryRoute(28,bad),{code:'REGULAR_DELIVERY_ROUTE_INVALID'});
 }
});
const material={remoteLineId:10,itemId:100,quantity:20,backorderedQuantity:5,uom:'EA',locationId:28,open:true};
const order=()=>({id:1000,ref:'SOB1000',locationId:28,lines:[{...material},{remoteLineId:11,itemId:-2,quantity:null,ancillary:true}]});
test('SO materials retain quantities and repeated items and exclude ancillary lines',()=>{
 const so=order();so.lines.push({...material,remoteLineId:12,quantity:30});
 assert.deepEqual(deliveryMaterials(so,28),[material,{...material,remoteLineId:12,quantity:30}]);
});
test('property: hostile or unfulfillable SO snapshots cannot become delivery requests',()=>{
 fc.assert(fc.property(fc.constantFrom(0,-1,NaN,Infinity,1_000_000_001),quantity=>{
  const so=order();so.lines[0].quantity=quantity;
  assert.throws(()=>deliveryMaterials(so,28),{code:'REGULAR_SO_MISMATCH'});
 }),{seed:15012441,numRuns:100});
 const zero=order();zero.lines.push({...material,remoteLineId:99,quantity:0,backorderedQuantity:0});assert.throws(()=>deliveryMaterials(zero,28),{code:'REGULAR_SO_MISMATCH'});
 for(const change of [so=>{so.lines[0].locationId=1;},so=>{so.lines[0].open=false;},so=>{so.lines[0].uom='';},so=>{so.lines=[];},so=>{so.lines.push({...so.lines[0]});},so=>{so.id=0;}]){
  const so=order();change(so);assert.throws(()=>deliveryMaterials(so,28),{code:'REGULAR_SO_MISMATCH'});
 }
});

test('property: a positive backorder selects the whole line, while zero backorder selects none',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.integer({min:1,max:1000}),(quantity,seed)=>{
  const so=order(),backorderedQuantity=Math.min(quantity,seed);
  so.locationId=1; // Header does not determine Base Yard.
  so.lines[0]={...so.lines[0],quantity,backorderedQuantity};
  so.lines.push({...material,remoteLineId:12,quantity:77,backorderedQuantity:0,open:false});
  assert.deepEqual(deliveryMaterials(so,28),[so.lines[0]]);
 }),{seed:34452967,numRuns:300});
});
test('unknown, negative and inconsistent backorders cannot silently become full-line transfers',()=>{
 for(const value of [null,undefined,NaN,Infinity,-1,21]){
  const so=order();so.lines[0].backorderedQuantity=value;
  assert.throws(()=>deliveryMaterials(so,28),{code:'REGULAR_SO_MISMATCH'});
 }
 const so=order();so.lines[0].backorderedQuantity=0;
 assert.throws(()=>deliveryMaterials(so,28),{code:'REGULAR_DELIVERY_NO_BACKORDER'});
});

test('Base Yard follows all material line locations, independently of the header',()=>{
 const so=order();so.locationId=15;assert.equal(deliveryBaseYard(so).locationId,28);
 so.lines.push({...material,remoteLineId:20,locationId:1});assert.throws(()=>deliveryBaseYard(so),{code:'REGULAR_SO_MISMATCH'});
});
test('property: each selected line transfers its whole quantity or backorder without exceeding shared availability',()=>{
 fc.assert(fc.property(fc.array(fc.record({quantity:fc.integer({min:1,max:1000}),minimum:fc.integer({min:1,max:1000})}),{minLength:1,maxLength:10}),fc.integer({min:0,max:10000}),(rows,available)=>{
  const lines=rows.map((line,index)=>({...material,remoteLineId:index+1,quantity:line.quantity,backorderedQuantity:Math.min(line.quantity,line.minimum)}));
  const minimum=lines.reduce((sum,line)=>sum+line.backorderedQuantity,0);
  if(available<minimum){assert.throws(()=>deliveryQuantities(lines,[{itemId:100,requestableAvailable:available}]),{code:'REGULAR_DELIVERY_STOCK_SHORTAGE'});return;}
  const result=deliveryQuantities(lines,[{itemId:100,requestableAvailable:available}]);
  assert(result.reduce((sum,line)=>sum+line.quantity,0)<=available);
  result.forEach((line,index)=>assert([lines[index].quantity,lines[index].backorderedQuantity].includes(line.quantity)));
  if(available>=lines.reduce((sum,line)=>sum+line.quantity,0))assert.deepEqual(result.map(line=>line.quantity),lines.map(line=>line.quantity));
 }),{seed:29673445,numRuns:300});
 const lines=[{...material,quantity:100,backorderedQuantity:20},{...material,remoteLineId:12,quantity:100,backorderedQuantity:30}];
 assert.deepEqual(deliveryQuantities(lines,[{itemId:100,requestableAvailable:130}]).map(line=>line.quantity),[100,30]);
 for(const availability of [[],[{itemId:100,requestableAvailable:NaN}]])assert.throws(()=>deliveryQuantities(lines,availability),{code:'REGULAR_DELIVERY_STOCK_SHORTAGE'});
});
