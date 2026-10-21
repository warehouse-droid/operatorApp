import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {evaluateRegularStockApproval,regularApprovalExpired,requireRegularStockApproval} from '../../../src/regular-stock-domain.js';

const evaluate=(deliveryMethod,overrides={})=>evaluateRegularStockApproval({deliveryMethod,leadHours:12,now:0,arrivalAt:0,
 lines:[{id:1,itemId:100,sourceLocationId:1,salesQty:200,salesUom:'EA'}],
 policies:[{itemId:100,sourceLocationId:1,availableQuantity:1000,safetyQuantity:800}],...overrides});
test('Pickup has no lead-time gate; Delivery keeps its configured inclusive boundary',()=>{
 const pickup=evaluate('pickup');assert.equal(pickup.automatic,true);assert.equal(pickup.enoughTime,true);assert.equal(pickup.leadTimeApplies,false);
 assert.deepEqual(pickup.lines[0].reasons,[]);
 assert.equal(evaluate('delivery').automatic,false);
 assert.equal(evaluate('delivery',{arrivalAt:12*3600000-1}).automatic,false);
 assert.equal(evaluate('delivery',{arrivalAt:12*3600000}).automatic,true);
});
test('Pickup still checks safety, aggregate quantities, missing policy and the enabled switch',()=>{
 assert.equal(evaluate('pickup',{autoApprovalEnabled:false}).automatic,false);
 assert.equal(evaluate('pickup',{policies:[]}).automatic,false);
 const grouped=evaluate('pickup',{lines:[{id:1,itemId:100,sourceLocationId:1,salesQty:100},{id:2,itemId:100,sourceLocationId:1,salesQty:101}]});
 assert.equal(grouped.automatic,false);assert.equal(grouped.lines[0].remainingQuantity,799);
 assert.deepEqual(grouped.lines[0].reasons,['below_safety']);
});
test('Stocking always requires manual review even at safe stock and sufficient lead time',()=>{
 const result=evaluate('stocking',{arrivalAt:24*3600000});
 assert.equal(result.automatic,false);assert(result.lines[0].reasons.includes('stocking_scm_review'));
});
test('Pickup uses approval expiry and SO access; Stocking and saved legacy direct TOs cannot use an SO',()=>{
 const regular={deliveryMethod:'pickup',approvalExpiresAt:new Date(900000).toISOString(),approvalValidityMinutes:15};
 assert.equal(regularApprovalExpired({regular},899999),false);assert.equal(regularApprovalExpired({regular},900000),true);
 assert.doesNotThrow(()=>requireRegularStockApproval({regular},899999));
 assert.throws(()=>requireRegularStockApproval({regular},900000),{code:'REGULAR_APPROVAL_EXPIRED'});
 assert.equal(regularApprovalExpired({regular:{...regular,deliveryMethod:'stocking'}},900001),false);
 for(const fields of [{deliveryMethod:'stocking'},{deliveryMethod:'pickup',pickupTransfer:{status:'attention'}}]){
  assert.throws(()=>requireRegularStockApproval({regular:{...regular,...fields}},0),/Stocking/);
 }
});
test('property: approval truth table distinguishes Pickup, Delivery and Stocking',()=>{
 fc.assert(fc.property(fc.constantFrom('pickup','delivery','stocking'),fc.boolean(),fc.integer({min:0,max:1000}),fc.integer({min:0,max:1000}),fc.integer({min:0,max:48}),fc.integer({min:0,max:48}),
  (method,enabled,available,safety,lead,arrival)=>{
   const actual=evaluate(method,{autoApprovalEnabled:enabled,leadHours:lead,arrivalAt:arrival*3600000,policies:[{itemId:100,sourceLocationId:1,availableQuantity:available,safetyQuantity:safety}]});
   const expected=method!=='stocking'&&enabled&&available-200>=safety&&(method==='pickup'||arrival>=lead);
   assert.equal(actual.automatic,expected);
   if(method==='pickup')assert(!actual.lines[0].reasons.includes('short_lead_time'));
  }),{seed:296729,numRuns:400});
});
test('property: Pickup expires at the configured instant, Stocking has no Sales clock',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:10080}),fc.integer({min:-1,max:1}),(minutes,offset)=>{
  const regular={deliveryMethod:'pickup',approvalExpiresAt:new Date(minutes*60000).toISOString()};
  assert.equal(regularApprovalExpired({regular},minutes*60000+offset),offset>=0);
  assert.equal(regularApprovalExpired({regular:{...regular,deliveryMethod:'stocking'}},minutes*60000+offset),false);
 }),{seed:296730,numRuns:100});
});
const window={MBBS_I18N:{language:()=> 'en'}};
vm.runInNewContext(readFileSync(new URL('../../../public/regular-stock-ui.js',import.meta.url),'utf8'),{window,Intl});
test('UI offers Stocking separately and Pickup shows SO entry with no lead-time requirement',()=>{
 const fields=window.RegularStockUI.fields({workflowVersion:2,deliveryMethod:'stocking'});
 for(const method of ['pickup','delivery','stocking'])assert(fields.includes(`value="${method}"`));
 const request={workflowVersion:2,regular:{deliveryMethod:'pickup',approvalExpiresAt:'2099-01-01T00:00:00Z',approval:{automatic:true,enoughTime:true,leadHours:12,leadTimeApplies:false,lines:[]}},lines:[{status:'approved',decision:'stock'}]};
 assert.match(window.RegularStockUI.salesOrder(request,false),/data-regular-so/);
 const summary=window.RegularStockUI.summary(request);assert.match(summary,/No minimum lead time/);assert.doesNotMatch(summary,/12 hours|Pickup requires SCM/);
 const stocked={...request,regular:{...request.regular,deliveryMethod:'stocking',approval:{...request.regular.approval,automatic:false}}};
 assert.match(window.RegularStockUI.summary(stocked),/Stocking.*SCM/s);assert.doesNotMatch(window.RegularStockUI.salesOrder(stocked,false),/data-regular-so/);
 window.MBBS_I18N.language=()=> 'zh-CN';assert.match(window.RegularStockUI.summary(request),/无需最短提前时间/);assert.match(window.RegularStockUI.summary(stocked),/备货/);window.MBBS_I18N.language=()=> 'en';
});
