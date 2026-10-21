import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {linkedTransferDriverScope,transferPostingDate} from '../../../src/transfer-order-posting-link-domain.js';
import {transferPostingCompletion,buildTransferPostingDraft} from '../../../src/transfer-order-posting-domain.js';
const dependency=(extra={})=>({id:271,dependency_mode:'direct_to_customer',status:'active',same_load_required:true,
 sales_order_ref:'SOA09694',dispatch_target_ref:'GOA-9694-9702',source_order_refs:['SOA09702','SOA09694'],
 planned_plan_id:345,planned_load_id:'load4',planned_date:'2026-10-03',...extra});
const target={dependencyIds:['271'],orderRefs:['SOA09694','SOA09702'],dispatchRefs:['GOA-9694-9702']};
const job=(extra={})=>({id:'b29da5d9-72ec-4d75-87ea-1d82c07fb3a6',transaction_type:'IF',local_to_id:1037331,
 order_ref:'TOB01191',operator_id:'operator',operator_record_id:2826,snapshot:{planId:'345',loadId:'load4',planDate:'2026-10-03',
 driverTarget:target,locationId:1,lines:[{lineId:'501613',sourceLineKey:'5074480',itemId:1188,quantity:51}]},...extra});
const event=(ref,id,extra={})=>({id,order_kind:'SO',order_ref:ref,plan_id:345,load_id:'load4',plan_date:'2026-10-03',
 completion_evidence_type:'driver_job',completion_evidence_id:'dropoff',driver_status:'complete',stop_type:'dropoff',completed_at:'2026-10-03T22:52:00Z',...extra});
test('linked scope preserves group members and normalizes Date values',()=>{
 assert.equal(transferPostingDate(new Date('2026-10-03T00:00:00Z')),'2026-10-03');
 assert.equal(transferPostingDate('2026-10-03T00:00:00.000Z'),'2026-10-03');
 assert.equal(transferPostingDate(null),null);assert.equal(transferPostingDate('Sat Oct 03'),null);
 assert.equal(transferPostingDate('2026-02-30'),null);
 const scope=linkedTransferDriverScope([dependency({planned_date:new Date('2026-10-03T00:00:00Z')})]);
 assert.deepEqual(scope,{driverTarget:target,planId:'345',loadId:'load4',planDate:'2026-10-03',linkError:null});
 assert.equal(linkedTransferDriverScope([dependency({dependency_mode:'yard_replenishment'})]),null);
 assert.equal(linkedTransferDriverScope([dependency({status:'cancelled'})]),null);
});
test('registered split uses its exact delivery reference; invalid linked scope stays blocked',()=>{
 const split=linkedTransferDriverScope([dependency({dispatch_target_ref:'SOA09694-S2'})]);
 assert.deepEqual(split.driverTarget.orderRefs,['SOA09694-S2']);
 for(const change of [{planned_plan_id:null},{planned_load_id:null},{planned_date:'Sat Oct 03'},{same_load_required:false},{status:'attention'}])
  assert.match(linkedTransferDriverScope([dependency(change)]).linkError,/linked SO/i);
 assert.match(linkedTransferDriverScope([dependency(),dependency({id:272,planned_load_id:'different'})]).linkError,/linked SO/i);
});
test('linked SO group completion releases exact Operator quantity and retains every completion',()=>{
 const j=job(),events=[event('SOA09694',20584),event('SOA09702',20585)];
 const completed=transferPostingCompletion(j,events);assert.ok(completed);assert.equal(completed.linkedEvents.length,2);
 const draft=buildTransferPostingDraft(j,{sourceOrderKind:'TO',sourceNetSuiteId:1037331,sourceOrderRef:'TOB01191',
  availableLines:[{sourceLineKey:'5074480',orderLine:2,itemId:1188,remainingQuantity:51,location:1}]},
  {effective:true,functionKey:'delivery_prep',transactionType:'IF',gateKey:'test',revision:1,locationId:1,yardCode:'3445'},completed);
 assert.equal(draft.steps[0].payload.item.items[0].quantity,51);
 assert.equal(draft.inputSnapshot.transferEvidence.operatorRecordId,2826);
 assert.equal(transferPostingCompletion(j,events.slice(0,1)),null);
});
test('property: linked delivery requires every SO and both signals in the saved scope',()=>{
 fc.assert(fc.property(fc.tuple(...Array.from({length:8},()=>fc.boolean())),([operator,all,reference,kind,complete,drop,plan,load])=>{
  const j=job({operator_record_id:operator?2826:null});
  const events=[event('SOA09694',1),...(all?[event(reference?'SOA09702':'SOA99999',2,{
   order_kind:kind?'SO':'TO',driver_status:complete?'complete':'pending',stop_type:drop?'dropoff':'pickup',
   plan_id:plan?345:346,load_id:load?'load4':'other'})]:[])];
  assert.equal(Boolean(transferPostingCompletion(j,events)),operator&&all&&reference&&kind&&complete&&drop&&plan&&load);
 }),{seed:1037331,numRuns:300});
});
test('property: dates and explicit group membership never depend on row order',()=>{
 fc.assert(fc.property(fc.integer({min:0,max:365}),fc.boolean(),(days,reverse)=>{
  const day=new Date(Date.UTC(2026,0,1+days)),expected=day.toISOString().slice(0,10);
  assert.equal(transferPostingDate(day),expected);
  const refs=reverse?['SOA09702','SOA09694']:['SOA09694','SOA09702'];
  const scope=linkedTransferDriverScope([dependency({source_order_refs:refs,planned_date:day})]);
  assert.deepEqual(scope.driverTarget.orderRefs,target.orderRefs);assert.equal(scope.planDate,expected);
 }),{seed:1037048,numRuns:80});
});
test('property: every single missing signal blocks a linked fulfillment',()=>{
 fc.assert(fc.property(fc.integer({min:0,max:9}),index=>{
  const j=job(),e=event('SOA09702',2),events=[event('SOA09694',1),e];
  const changes=[()=>j.operator_record_id=null,()=>events.pop(),()=>e.order_ref='SOA99999',()=>e.order_kind='TO',
   ()=>e.driver_status='pending',()=>e.stop_type='pickup',()=>e.plan_id=346,()=>e.load_id='other',()=>e.plan_date='2026-10-02'];
  changes[index]?.();assert.equal(Boolean(transferPostingCompletion(j,events)),index===9);
 }),{seed:271,numRuns:100});
});
test('property: inactive linked plans never yield a postable scope',()=>{
 fc.assert(fc.property(fc.boolean(),active=>{
  const scope=linkedTransferDriverScope([dependency({plan_active:active})]);
  assert.equal(scope.linkError===null,active);
 }),{seed:271,numRuns:20});
});
