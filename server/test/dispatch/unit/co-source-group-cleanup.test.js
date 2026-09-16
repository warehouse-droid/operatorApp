import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {createCoCleanupManifest} from "../../../tools/co-source-cleanup-repository.mjs";

function fixture({members=[true,true],local=false,registry="retired"}={}) {
  const orders=members.map((_,i)=>({netsuite_id:String(81050+i),tranid:`SO-GROUP-CLEANUP-${i}`,sales_order_type:"Delivery",
    status:"B",operator_status:"open",local_yard_order_status:"Open",netsuite_active:true}));
  const refs=orders.map(order=>order.tranid),group="GOA-GROUP-CLEANUP";
  const co={id:"90150",co_ref:`CO-${group}`,source_order_ref:group,status:"pending_load",details:{
    sourceOrderId:group,sourceOrderType:"SO",childOrderIds:refs,
    childOrderDetails:refs.map(id=>({id,type:"SO",netsuiteStatus:"G"}))}};
  const state={so:{orders,lines:[],splits:[],completions:[],reloads:[],claims:[],allocations:[],
    driverCompletedRefs:local?refs.filter((_,i)=>members[i]):[]},cos:[co],lines:[],
    groups:registry==="missing"?[]:[{group_ref:group,active:registry==="active",members:refs}],completions:[]};
  const remote={mode:"netsuite-read-only-select",completedAt:new Date().toISOString(),rows:local?[]:
    orders.filter((_,i)=>members[i]).map(order=>({id:order.netsuite_id,tranid:order.tranid,status:iStatus(order.netsuite_id)}))};
  return {state,remote,refs};
}
function iStatus(id) {return Number(id)%2?"G":"F";}

test("a retired source group CO is Loaded when all recorded members are NetSuite fulfilled",()=>{
  const {state,remote}=fixture();
  const manifest=createCoCleanupManifest(state,remote);
  assert.equal(manifest.entries.length,1);
  assert.equal(manifest.entries[0].after.order.status,"planned");
  assert.equal(manifest.entries[0].source.kind,"recorded_co_group");
  assert.equal(state.groups[0].active,false);
});
test("a grouped CO absent from the legacy registry uses its recorded locally delivered SO members",()=>{
  const {state,remote}=fixture({local:true,registry:"missing"});
  const manifest=createCoCleanupManifest(state,remote);
  assert.equal(manifest.entries.length,1);
  assert(manifest.entries[0].source.members.every(member=>member.kind==="local_dispatch_completion"));
});
test("older COs with recorded source and member IDs do not require optional child cards",()=>{
  const {state,remote}=fixture();
  delete state.cos[0].details.childOrderDetails;
  assert.equal(createCoCleanupManifest(state,remote).entries.length,1);
  state.cos[0].details.childOrderDetails=[];
  assert.equal(createCoCleanupManifest(state,remote).entries.length,1);
});
test("conflicting, duplicate, or incomplete recorded CO identities cannot authorize cleanup",()=>{
  for(const mutate of [
    co=>{co.details.sourceOrderId="GOA-DIFFERENT";},
    co=>{co.details.sourceOrderType="PO";},
    co=>{co.details.childOrderIds[1]=co.details.childOrderIds[0];},
    co=>{co.details.childOrderDetails.pop();},
    co=>{co.details.childOrderDetails[0].id="SO-DIFFERENT";},
    co=>{co.details.childOrderDetails[0].type="PO";}
  ]) {
    const {state,remote}=fixture({registry:"active"});
    mutate(state.cos[0]);
    assert.equal(createCoCleanupManifest(state,remote).entries.length,0);
  }
});
test("property: historical CO groups require every real member complete and never bypass skipped sources",()=>{
  fc.assert(fc.property(fc.array(fc.boolean(),{minLength:2,maxLength:6}),fc.boolean(),
    fc.constantFrom("retired","missing","active"),fc.boolean(),
    fc.constantFrom("valid","source_mismatch","duplicate","partial_details","wrong_type","member_mismatch"),
    (members,local,registry,skip,identity)=>{
      const {state,remote,refs}=fixture({members,local,registry});
      const details=state.cos[0].details;
      if(identity==="source_mismatch") details.sourceOrderId="GOA-ANOTHER";
      if(identity==="duplicate") details.childOrderIds[1]=details.childOrderIds[0];
      if(identity==="partial_details") details.childOrderDetails.pop();
      if(identity==="wrong_type") details.sourceOrderType="PO";
      if(identity==="member_mismatch") details.childOrderDetails[0].id="SO-ANOTHER";
      const before=structuredClone(state),skipSourceRefs=skip?[refs[0]]:[];
      const plan=createCoCleanupManifest(state,remote,{skipSourceRefs});
      assert.equal(plan.entries.length,identity==="valid"&&!skip&&members.every(Boolean)?1:0);
      assert.deepEqual(state,before);
      if(plan.entries.length) {
        const next=createCoCleanupManifest({...state,cos:[plan.entries[0].after.order]},remote,{skipSourceRefs});
        assert.deepEqual(next.entries[0].before,next.entries[0].after);
        assert.equal(plan.entries[0].after.order.loaded_at,undefined);
      }
    }),{seed:20260915,numRuns:400});
});
