import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as domain from '../../../src/regular-stock-domain.js';
import * as input from '../../../public/regular-stock-input.js';

const evaluate=(extra={})=>domain.evaluateRegularStockApproval({lines:[{id:1,itemId:10,itemName:'STONE',sourceLocationId:1,salesQty:200,salesUom:'EACH'}],
 policies:[{itemId:10,sourceLocationId:1,availableQuantity:1000,safetyQuantity:800}],now:0,arrivalAt:5*3600000,leadHours:5,...extra});
test('disabled auto-approval gate requires review even when every stock and lead condition passes',()=>{
 const result=evaluate({autoApprovalEnabled:false});assert.equal(result.automatic,false);assert.equal(result.autoApprovalEnabled,false);
 assert(result.lines[0].reasons.includes('auto_approval_disabled'));
});
test('gate property: automatic approval is exactly gate AND safety AND lead',()=>{
 fc.assert(fc.property(fc.boolean(),fc.integer({min:1,max:400}),fc.integer({min:0,max:10}),(enabled,quantity,hours)=>{
  const result=evaluate({autoApprovalEnabled:enabled,lines:[{id:1,itemId:10,sourceLocationId:1,salesQty:quantity}],arrivalAt:hours*3600000});
  assert.equal(result.automatic,enabled&&quantity<=200&&hours>=5);
  assert.equal(result.lines[0].reasons.includes('auto_approval_disabled'),!enabled);
 }),{numRuns:200,seed:15005});
});
test('approval validity settings default to 15 minutes and reject invalid durations',()=>{
 assert.equal(input.normalizeRegularApprovalMinutes(),15);assert.equal(input.normalizeRegularApprovalMinutes('30'),30);
 for(const value of [0,-1,null,'',true,1.5,10081,Infinity])assert.throws(()=>input.normalizeRegularApprovalMinutes(value),{code:'REGULAR_APPROVAL_MINUTES_INVALID',status:400});
});
test('expiry property: unused approvals expire at the exact deadline and started work remains recoverable',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:10080}),fc.oneof(fc.constant(0),fc.integer({min:-100000,max:100000})),(minutes,delta)=>{
  const start=new Date('2026-09-29T00:00:00Z'),deadline=start.getTime()+minutes*60000;
  const request={regular:{approvalExpiresAt:new Date(deadline).toISOString(),approvalValidityMinutes:minutes}};
  assert.equal(domain.regularApprovalExpired(request,new Date(deadline+delta)),delta>=0);
  if(delta>=0)assert.throws(()=>domain.requireRegularStockApproval(request,new Date(deadline+delta)),{code:'REGULAR_APPROVAL_EXPIRED',status:409});
  else assert.doesNotThrow(()=>domain.requireRegularStockApproval(request,new Date(deadline+delta)));
  assert.equal(domain.regularApprovalExpired({...request,regular:{...request.regular,handoffStatus:'attention'}},new Date(deadline+1000000)),false);
 }),{numRuns:200,seed:15006});
});
const window={MBBS_I18N:{language:()=> 'en'}};
vm.runInNewContext(readFileSync(new URL('../../../public/regular-stock-ui.js',import.meta.url),'utf8'),{window,Intl},{filename:new URL('../../../public/regular-stock-ui.js',import.meta.url).pathname});
test('review reasons name the lead requirement, gate, item and below-safety quantities',()=>{
 const request={workflowVersion:2,regular:{approval:{...evaluate({autoApprovalEnabled:false,arrivalAt:3600000,lines:[{id:1,itemId:10,sourceLocationId:1,salesQty:201,salesUom:'EACH'}]})}},
  lines:[{id:1,itemId:10,itemName:'STONE <unsafe>',sourceName:'3445',salesUom:'EACH'}]};
 const html=window.RegularStockUI.summary(request);
 assert.match(html,/Auto-approval is turned off/);assert.match(html,/at least 5 hours of lead time/);
 assert.match(html,/STONE &lt;unsafe&gt;[\s\S]*3445[\s\S]*799[\s\S]*800/);assert.doesNotMatch(html,/<unsafe>/);
});
test('expired approval offers Sales a re-raise action instead of SO confirmation',()=>{
 const html=window.RegularStockUI.salesOrder({workflowVersion:2,regular:{approvalExpiresAt:'2000-01-01T00:00:00Z',approvalValidityMinutes:15},lines:[{decision:'stock',status:'approved'}]},false);
 assert.match(html,/Approval expired/);assert.match(html,/Re-raise request/);assert.doesNotMatch(html,/data-regular-so/);
});
test('completed STREQ-000059 shows the approval snapshot without subtracting its shipment twice',()=>{
 const approved={lineId:133,availableQuantity:1171.52,groupedRequestedQuantity:523,safetyQuantity:296.0278324,remainingQuantity:648.52,shortfallQuantity:0,unit:'SQFT'};
 const line={id:133,salesUom:'SQFT',approvalEvidence:approved};
 const request={workflowVersion:2,regular:{handoffStatus:'complete'},currentEvidence:[{...approved,availableQuantity:648.52,remainingQuantity:125.52,shortfallQuantity:170.5078324}],
  currentAvailability:[{lineId:133,availableQuantity:648.52}]};
 const html=window.RegularStockUI.safety(request,line);
 assert.match(html,/Available at approval[\s\S]*1,171.52/);assert.match(html,/Remaining after approved request[\s\S]*648.52/);
 assert.doesNotMatch(html,/Current availability|125.52|170.5078/);
 const next=evaluate({lines:[{id:1,itemId:10,sourceLocationId:1,salesQty:523,salesUom:'SQFT'}],policies:[{itemId:10,sourceLocationId:1,availableQuantity:648.52,safetyQuantity:296.0278324}]});
 assert.equal(next.automatic,false);assert(next.lines[0].reasons.includes('below_safety'));
});
