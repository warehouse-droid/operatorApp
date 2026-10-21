import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {evaluateRegularStockApproval} from '../../../src/regular-stock-domain.js';
const evaluate=(deliveryMethod,enabled=true)=>evaluateRegularStockApproval({deliveryMethod,autoApprovalEnabled:enabled,lines:[{id:1,itemId:100,sourceLocationId:1,salesQty:200,salesUom:'EA'}],policies:[{itemId:100,sourceLocationId:1,availableQuantity:1000,safetyQuantity:800}],arrivalAt:5*3600000,now:0});
test('Stocking always requires SCM review even exactly at safety stock and minimum lead time',()=>{
 const pickup=evaluate('stocking');assert.equal(pickup.automatic,false);assert(pickup.lines[0].reasons.includes('stocking_scm_review'));
 assert.equal(evaluate('delivery').automatic,true);
});
test('Stocking gate property: safety, gate and lead can never authorize automatic Stocking',()=>{
 fc.assert(fc.property(fc.boolean(),fc.integer({min:200,max:1000000}),fc.integer({min:5,max:1000}),(enabled,available,hours)=>{
  const input={deliveryMethod:'stocking',autoApprovalEnabled:enabled,lines:[{id:1,itemId:100,sourceLocationId:1,salesQty:200}],policies:[{itemId:100,sourceLocationId:1,availableQuantity:available,safetyQuantity:0}],arrivalAt:hours*3600000,now:0};
  const result=evaluateRegularStockApproval(input);assert.equal(result.automatic,false);assert(result.lines[0].reasons.includes('stocking_scm_review'));
  assert.equal(evaluateRegularStockApproval({...input,deliveryMethod:'delivery'}).automatic,enabled);
 }),{seed:296715,numRuns:200});
});
const window={MBBS_I18N:{language:()=> 'en'}};
vm.runInNewContext(readFileSync(new URL('../../../public/regular-stock-ui.js',import.meta.url),'utf8'),{window,Intl},{filename:new URL('../../../public/regular-stock-ui.js',import.meta.url).pathname});
test('Sales Stocking waits for SCM without SO entry or expired-approval action',()=>{
 const request={workflowVersion:2,regular:{deliveryMethod:'stocking',approvalExpiresAt:'2000-01-01T00:00:00Z',approval:{automatic:false,enoughTime:true,leadHours:5,lines:[]}},lines:[{status:'approved',decision:'stock'}]};
 assert.match(window.RegularStockUI.salesOrder(request,false),/SCM/);assert.doesNotMatch(window.RegularStockUI.salesOrder(request,false),/data-regular-so|data-sales-stock-action="re-raise"/);
 assert.match(window.RegularStockUI.summary(request),/Stocking.*SCM/);
});
