import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import fc from 'fast-check';
import {regularStockConfirmationToken,requireRegularStockConfirmation} from '../../../src/regular-stock-confirmation.js';
import {planRegularStockRouting} from '../../../src/regular-stock-domain.js';

const input=(approved,actual)=>({request:{destinationLocationId:1,lines:[{id:134,itemId:9736,itemName:'TH-COV60T-1530-AUB',sourceLocationId:28,salesQty:approved,salesUom:'EACH',decision:'stock'}]},salesOrder:{id:1024553,ref:'SOB121631',locationId:1,lines:[{remoteLineId:5044333,itemId:9736,quantity:actual,uom:'EACH',locationId:1,open:true}]}});
const message=(approved,actual)=>`Quantity mismatch for TH-COV60T-1530-AUB: the stock request approves ${approved} EACH, but SOB121631 has ${actual} EACH. Quantities must match before linking the SO.`;
test('760 approved versus 912 on SOB121631 explains the exact discrepancy',()=>{
 assert.throws(()=>planRegularStockRouting(input(760,912)),{message:message(760,912),code:'REGULAR_SO_MISMATCH',status:409});
});
test('quantity message property: either direction reports the true quantities and equality still routes',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.integer({min:1,max:100000}),fc.boolean(),(quantity,delta,over)=>{
  const [approved,actual]=over?[quantity,quantity+delta]:[quantity+delta,quantity];
  assert.throws(()=>planRegularStockRouting(input(approved,actual)),{message:message(approved,actual),code:'REGULAR_SO_MISMATCH',status:409});
  assert.equal(planRegularStockRouting(input(quantity,quantity)).mode,'location');
 }),{numRuns:200,seed:121631});
});
test('multiple exact rows still request selection instead of reporting a false mismatch',()=>{
 const value=input(760,760);value.salesOrder.lines.push({...value.salesOrder.lines[0],remoteLineId:5044334});
 assert.throws(()=>planRegularStockRouting(value),{message:'Select the exact open SO line for TH-COV60T-1530-AUB with quantity 760.'});
 assert.equal(planRegularStockRouting({...value,selectedLineIds:{9736:5044334}}).mode,'transfer');
});
const window={MBBS_I18N:{language:()=> 'en'}};
vm.runInNewContext(readFileSync(new URL('../../../public/regular-stock-ui.js',import.meta.url),'utf8'),{window,Intl},{filename:new URL('../../../public/regular-stock-ui.js',import.meta.url).pathname});
const ui=window.RegularStockUI;
test('location confirmation explains all lines including non-stock and completed history retains the target',()=>{
 const action={mode:'location',salesOrderRef:'SOB121631',sourceName:'2967',destinationName:'3445',lineCount:3};
 assert.match(ui.confirmationMessage(action),/SOB121631[\s\S]*3[\s\S]*2967/);
 assert.match(ui.confirmationMessage(action),/PALLET[\s\S]*discount[\s\S]*subtotal[\s\S]*delivery fee/i);
 const html=ui.salesOrder({workflowVersion:2,regular:{salesOrderRef:'SOB121631',routingMode:'location',handoffStatus:'complete',routingAction:action,routingCompletedAt:'2026-09-29T05:00:00Z'},lines:[]},false);
 assert.match(html,/SOB121631[\s\S]*2967/);assert.match(html,/2026-09-29/);
});
test('transfer confirmation and saved result name each route and issued TO; untrusted references are escaped',()=>{
 const action={mode:'transfer',salesOrderRef:'SO-MIX',destinationName:'2967',routes:[{sourceName:'3445',destinationName:'2967'},{sourceName:'150',destinationName:'2967'}]};
 assert.match(ui.confirmationMessage(action),/2[\s\S]*Transfer Orders[\s\S]*3445[\s\S]*2967[\s\S]*150/);
 const html=ui.salesOrder({workflowVersion:2,regular:{handoffStatus:'complete',routingMode:'transfer',routingAction:action,routingTransfers:[{reference:'TO-ONE<script>',sourceName:'3445',destinationName:'2967'},{reference:'TO-TWO',sourceName:'150',destinationName:'2967'}]},lines:[]},false);
 assert.match(html,/TO-ONE&lt;script&gt;/);assert.match(html,/TO-TWO/);assert.doesNotMatch(html,/<script>/);
});
test('old completed requests can still show the source yard and TO reference',()=>{
 const regular={handoffStatus:'complete',routingMode:'location',salesOrderRef:'SO-OLD'};
 assert.match(ui.salesOrder({workflowVersion:2,regular,lines:[{decision:'stock',sourceName:'2967'}]},false),/SO-OLD[\s\S]*2967/);
 assert.match(ui.salesOrder({workflowVersion:2,regular:{...regular,routingMode:'transfer'},lines:[],transfers:[{netsuiteTransferOrderRef:'TO-OLD',sourceName:'3445',destinationName:'2967'}]},false),/TO-OLD/);
});

test('confirmation property: serialized plans retain approval, changed identity or action cannot execute',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:10000}),fc.integer({min:1,max:10000}),(requestId,qty)=>{
  const value=input(qty,qty),plan={...planRegularStockRouting(value),order:value.salesOrder,createdAt:new Date('2026-09-29T00:00:00Z')};
  const token=regularStockConfirmationToken(requestId,plan);
  const restored=JSON.parse(JSON.stringify(plan));
  assert.equal(regularStockConfirmationToken(requestId,restored),token);
  assert.doesNotThrow(()=>requireRegularStockConfirmation(requestId,restored,token));
  assert.throws(()=>requireRegularStockConfirmation(requestId,plan),{code:'REGULAR_CONFIRMATION_REQUIRED'});
  for(const changed of [{...restored,mode:'transfer'},{...restored,sourceLocationId:26},{...restored,order:{...restored.order,customerId:42}},
   {...restored,order:{...restored.order,lines:restored.order.lines.map(line=>({...line,quantity:qty+1}))}}]){
   assert.throws(()=>requireRegularStockConfirmation(requestId,changed,token),{code:'REGULAR_CONFIRMATION_CHANGED'});
  }
  assert.throws(()=>requireRegularStockConfirmation(requestId+1,restored,token),{code:'REGULAR_CONFIRMATION_CHANGED'});
 }),{numRuns:150,seed:121632});
});

test('Sales API errors extract message text from structured responses instead of object coercion',()=>{
 const expected=message(760,912);
 for(const payload of [{error:{message:expected,code:'REGULAR_SO_MISMATCH'}},{message:expected,code:'REGULAR_SO_MISMATCH'},{error:expected,code:'REGULAR_SO_MISMATCH'}]){
  const error=ui.apiError(payload,409);assert.equal(error.message,expected);assert.equal(error.status,409);assert.equal(error.code,'REGULAR_SO_MISMATCH');
 }
 assert.equal(ui.apiError('Network is temporarily unavailable.',503).message,'Network is temporarily unavailable.');
 for(const payload of [{error:{}},{detail:{unexpected:true}},null,{error:'[object Object]'}]){
  const error=ui.apiError(payload,502);assert.equal(error.message,'Request failed (502). Please try again.');assert.equal(error.code,'');
 }
});
