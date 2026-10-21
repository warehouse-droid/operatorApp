import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import fc from 'fast-check';
import {evaluateRegularStockApproval} from '../../../src/regular-stock-domain.js';

const base={now:0,leadHours:5,lines:[{id:1,itemId:100,sourceLocationId:1,salesQty:200}],policies:[{itemId:100,sourceLocationId:1,availableQuantity:1000,safetyQuantity:800}]};
for(const method of ['pickup','stocking'])test(`${method} accepts omitted, null and stale invalid arrivals without creating a date`,()=>{
 for(const arrivalAt of [undefined,null,'','not a date',0,'2099-01-01T00:00:00Z']){
  const result=evaluateRegularStockApproval({...base,deliveryMethod:method,arrivalAt});
  assert.equal(result.arrivalAt,null);assert.equal(result.leadTimeApplies,false);assert.equal(result.enoughTime,true);
  assert.equal(result.automatic,method==='pickup');
  assert(!result.lines[0].reasons.includes('short_lead_time'));
 }
});
test('Delivery requires a valid arrival instant and retains the inclusive lead-time boundary',()=>{
 for(const arrivalAt of [undefined,null,'','not a date'])assert.throws(()=>evaluateRegularStockApproval({...base,deliveryMethod:'delivery',arrivalAt}),{code:'REGULAR_ARRIVAL_INVALID'});
 assert.equal(evaluateRegularStockApproval({...base,arrivalAt:5*3600000-1}).automatic,false);
 assert.equal(evaluateRegularStockApproval({...base,arrivalAt:5*3600000}).automatic,true);
});
test('property: irrelevant arrivals cannot affect safety, gate or Stocking manual review',()=>{
 fc.assert(fc.property(fc.constantFrom('pickup','stocking'),fc.oneof(fc.string(),fc.constant(null),fc.constant(undefined)),fc.boolean(),fc.integer({min:0,max:1200}),fc.integer({min:0,max:1000}),
  (deliveryMethod,arrivalAt,autoApprovalEnabled,availableQuantity,safetyQuantity)=>{
   const result=evaluateRegularStockApproval({...base,deliveryMethod,arrivalAt,autoApprovalEnabled,policies:[{...base.policies[0],availableQuantity,safetyQuantity}]});
   assert.equal(result.automatic,deliveryMethod==='pickup'&&autoApprovalEnabled&&availableQuantity-200>=safetyQuantity);
   assert.equal(result.arrivalAt,null);assert.equal(result.enoughTime,true);
   assert(!result.lines[0].reasons.includes('short_lead_time'));
  }),{seed:296741,numRuns:300});
});
test('property: Delivery alone validates missing arrivals and gates on the exact configured time',()=>{
 fc.assert(fc.property(fc.integer({min:0,max:48}),fc.integer({min:-1,max:1}),fc.constantFrom(undefined,null,'','invalid'),(hours,offset,missing)=>{
  assert.throws(()=>evaluateRegularStockApproval({...base,leadHours:hours,arrivalAt:missing}),{code:'REGULAR_ARRIVAL_INVALID'});
  const result=evaluateRegularStockApproval({...base,leadHours:hours,arrivalAt:hours*3600000+offset});
  assert.equal(result.automatic,offset>=0);assert.equal(result.arrivalAt,new Date(hours*3600000+offset).toISOString());
 }),{seed:296742,numRuns:150});
});
const window={MBBS_I18N:{language:()=> 'en'}};
vm.runInNewContext(readFileSync(new URL('../../../public/regular-stock-ui.js',import.meta.url),'utf8'),{window,Intl});
test('only Delivery renders mandatory arrival inputs; no-date summaries omit the empty card',async()=>{
 for(const deliveryMethod of ['','pickup','stocking']){
  const composer={workflowVersion:2,deliveryMethod,arrivalDate:'bad',arrivalTime:'bad'};
  assert.doesNotMatch(window.RegularStockUI.fields(composer),/data-regular-field="arrival(?:Date|Time)"/);
  await window.RegularStockUI.normalize(composer,{});
 }
 const fields=window.RegularStockUI.fields({workflowVersion:2,deliveryMethod:'delivery'});
 assert.match(fields,/data-regular-field="arrivalDate"[^>]*required/);assert.match(fields,/data-regular-field="arrivalTime"[^>]*required/);
 for(const deliveryMethod of ['pickup','stocking']){
  const request={workflowVersion:2,regular:{deliveryMethod,arrivalDate:null,arrivalTime:null,approval:{leadTimeApplies:false}},lines:[]};
  assert.doesNotMatch(window.RegularStockUI.summary(request),/Expected arrival/);
  const historical={...request,regular:{...request.regular,arrivalDate:'2026-09-29',arrivalTime:'15:00'}};
  assert.match(window.RegularStockUI.summary(historical),/Expected arrival.*2026-09-29 15:00/s);
 }
});
