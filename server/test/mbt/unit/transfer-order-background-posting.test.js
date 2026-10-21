import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {transferPostingCompletion,buildTransferPostingDraft,assertTransferPostingSourceCurrent} from '../../../src/transfer-order-posting-domain.js';
import {createOperatorNetSuitePostingTargetResolver} from '../../../src/operator-netsuite-posting-targets.js';
import {createOperatorNetSuitePostingAdmission} from '../../../src/operator-netsuite-posting-admission.js';

const job=(type='IF')=>({id:'af8b219c-59a6-4854-b1d7-6e11a39a7107',transaction_type:type,
  local_to_id:1036611,order_ref:'TOB01189',operator_id:'operator',operator_record_id:5,
  snapshot:{locationId:type==='IF'?1:28,planId:44,loadId:'load-2',photos:[],
    lines:[{lineId:501037,sourceLineKey:'5073149',itemId:2299,quantity:5}]}});
const event=(extra={})=>({id:99,order_kind:'TO',order_ref:'TOB01189',plan_id:44,load_id:'load-2',
  completion_evidence_type:'driver_job',completion_evidence_id:'drop-1',driver_status:'complete',stop_type:'dropoff',completed_at:'2026-10-03T12:00:00Z',...extra});
const source=()=>({sourceOrderKind:'TO',sourceNetSuiteId:1036611,sourceOrderRef:'TOB01189',
  availableLines:[{sourceLineKey:'5073149',sourceLineAliases:['5073149'],itemId:2299,orderLine:2,
    location:null,orderedQuantity:5,completedQuantity:0,remainingQuantity:5}]});
const policy=type=>({effective:true,functionKey:type==='IF'?'delivery_prep':'receiving',transactionType:type,
  gateKey:'test',revision:1,locationId:type==='IF'?1:28,yardCode:type==='IF'?'3445':'2967'});

test('the final transform boundary rechecks the exact live source item and remaining quantity',()=>{
 const step=buildTransferPostingDraft(job(),source(),policy('IF'),event()).steps[0];
 const current={sourceOrderKind:'TO',sourceNetSuiteId:1036611,sourceOrderRef:'TOB01189',lines:[
  {stage:'outbound',restOrderLine:2,itemId:2299,sourceLineKey:'5073149',identityStatus:'exact',remainingQuantity:5}]};
 assert.doesNotThrow(()=>assertTransferPostingSourceCurrent(step,current));
 for(const change of [s=>s.sourceNetSuiteId=1,s=>s.sourceOrderRef='TOB01190',s=>s.lines[0].itemId=1,
  s=>s.lines[0].remainingQuantity=4,s=>s.lines[0].stage='receiving',s=>s.lines[0].identityStatus='ambiguous',
  s=>s.lines.push({...s.lines[0]})]) {
  const changed=structuredClone(current);change(changed);
  assert.throws(()=>assertTransferPostingSourceCurrent(step,changed),{code:'TRANSFER_POSTING_EVIDENCE_INVALID'});
 }
});

for(const type of ['IF','IR']) {
  test(`${type} needs saved Operator evidence independently of Driver drop-off`,()=>{
    const j=job(type);assert.equal(transferPostingCompletion(j,[]).id,null);
    assert.equal(transferPostingCompletion({...j,operator_record_id:null},[event()]),null);
    assert.equal(transferPostingCompletion(j,[event()]).id,null);
    assert.equal(transferPostingCompletion(j,[event({completed_at:'2026-10-02T12:00:00Z'})]).id,null);
  });
  test(`${type} does not depend on pickup, incomplete, other-order, other-plan or other-load driver events`,()=>{
    for(const extra of [{stop_type:'pickup'},{driver_status:'pending'},{order_ref:'TOB01190'},
      {plan_id:45},{load_id:'load-3'},{completion_evidence_type:'operator'},{completed_at:null}]) {
      assert.equal(transferPostingCompletion(job(type),[event(extra)]).id,null,JSON.stringify(extra));
    }
  });
  test(`${type} freezes selected quantities and attaches the Operator identity without a Driver identity`,()=>{
    const j=job(type),s=source();if(type==='IR')s.availableLines[0].orderLine=3;
    const before=structuredClone(j),draft=buildTransferPostingDraft(j,s,policy(type),event());
    assert.deepEqual(draft.steps[0].payload.item.items,[{orderLine:type==='IF'?2:3,itemReceive:true,quantity:5}]);
    assert.deepEqual(j,before);
    assert.equal(draft.inputSnapshot.localOperation.kind,'transfer_background_posting');
    assert.equal(draft.inputSnapshot.transferEvidence.operatorRecordId,5);
    assert.equal(draft.inputSnapshot.transferEvidence.completionEventId,null);
    assert.ok(draft.claims.includes(`source:${type}:TO:1036611`));
    assert.ok(!draft.claims.includes(`${type==='IF'?'delivery_prep':'receiving'}:transfer_order:1036611`));
  });
}
test('backend refuses changed item, insufficient quantity, duplicate identity and missing source',()=>{
  for(const change of [s=>s.availableLines[0].itemId=10,s=>s.availableLines[0].remainingQuantity=4,
    s=>s.availableLines.push({...s.availableLines[0]}),s=>s.sourceNetSuiteId=-1]) {
    const s=source();change(s);assert.throws(()=>buildTransferPostingDraft(job(),s,policy('IF'),event()),/identity|quantity|source/i);
  }
});

test('malformed quantities fail while obsolete Driver scope does not gate a yard posting',()=>{
 for(const quantity of [0,-1,NaN,Infinity]){
  const j=job();j.snapshot.lines[0].quantity=quantity;
  assert.throws(()=>buildTransferPostingDraft(j,source(),policy('IF'),event()),{code:'TRANSFER_POSTING_EVIDENCE_INVALID'});
 }
 const j=job();j.snapshot.planDate='2026-10-03';
 assert.equal(transferPostingCompletion(j,[event({plan_date:'2026-10-02'})]).id,null);
 assert.equal(transferPostingCompletion(j,[event({plan_date:'2026-10-03'})]).id,null);
 assert.doesNotThrow(()=>buildTransferPostingDraft(j,source(),policy('IF'),event()));
 assert.throws(()=>buildTransferPostingDraft(job(),{...source(),sourceOrderKind:'PO'},policy('IF'),event()),/source identity/);
 const s=source();s.availableLines[0].remainingQuantity=NaN;
 assert.throws(()=>buildTransferPostingDraft(job(),s,policy('IF'),event()),/quantity/);
 const ambiguous=job();ambiguous.snapshot={...ambiguous.snapshot,planId:null,loadId:null};
 assert.equal(transferPostingCompletion(ambiguous,[event(),event({id:100,plan_id:45,load_id:'other'})]).id,null);
});
test('property: partial background fulfillment preserves exact finite quantity',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:500000}),n=>{
    const j=job(),s=source(),qty=n/100000;j.snapshot.lines[0].quantity=qty;
    assert.equal(buildTransferPostingDraft(j,s,policy('IF'),event()).steps[0].payload.item.items[0].quantity,qty);
  }),{seed:1036611,numRuns:60});
});
test('property: saved Operator evidence is necessary and sufficient regardless of Driver scope',()=>{
 fc.assert(fc.property(fc.tuple(...Array.from({length:5},()=>fc.boolean())),([operator,complete,dropoff,plan,load])=>{
  const j=job();if(!operator)j.operator_record_id=null;
  const e=event({driver_status:complete?'complete':'pending',stop_type:dropoff?'dropoff':'pickup',plan_id:plan?44:45,load_id:load?'load-2':'other'});
  assert.equal(Boolean(transferPostingCompletion(j,[e])),operator);
 }),{seed:1036611,numRuns:100});
});
for(const type of ['delivery_prep','receiving']) test(`${type} TO admission saves locally even with an invalid NetSuite identity`,async()=>{
  const root={netsuite_id:-99,tranid:'TO-local',order_type:'transfer_order',outbound_location_id:1,source_location_id:1,destination_location_id:28,lines:[]};
  const resolveTargets=createOperatorNetSuitePostingTargetResolver({getDeliveryOrder:async()=>root,
    getReceivableReceivingOrder:async()=>root,resolveRealSource:async()=>assert.fail('Operator must not resolve NetSuite IDs')});
  const admit=createOperatorNetSuitePostingAdmission({resolveTargets,getPolicy:async()=>assert.fail('No Operator NetSuite gate read'),
    createCommand:async()=>assert.fail('No synchronous transform'),onAccepted:async()=>assert.fail()});
  const result=await admit({functionKey:type,orderId:-99,orderType:'transfer_order',clientLocationId:type==='receiving'?28:1});
  assert.equal(result.mode,'local_only');assert.equal(result.reason,'transfer_background_owned');
});
