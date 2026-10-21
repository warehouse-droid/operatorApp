import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {binOrderReference,buildBinOrderWorkflow,assertBinWorkflowDependency} from "../../../src/mbt/bin-order-workflow-domain.js";

test("property: rental and exchange references remain unique across action classes and ordinals",()=>{
  fc.assert(fc.property(fc.integer({min:1,max:2_000_000}),fc.integer({min:1,max:10000}),(number,exchangeNumber)=>{
    const initial=binOrderReference(number,{kind:"delivery"});
    assert.equal(initial,`BIN${String(number).padStart(5,"0")}D`);
    const next=binOrderReference(number+1,{kind:"delivery"});
    const references=["delivery","collection","dump","return"].map(action=>binOrderReference(number,{kind:"exchange",exchangeNumber,action}));
    assert.equal(new Set([initial,next,...references]).size,6);
    assert.ok(references.every(ref=>ref.startsWith(initial.slice(0,-1)+`X-${exchangeNumber}`)));
    assert.notEqual(references[0],binOrderReference(number,{kind:"exchange",exchangeNumber:exchangeNumber+1,action:"delivery"}));
  }),{numRuns:500,seed:20261020});
});

test("property: different-bin collection-first releases only delivery and retains the old bin's dump/return",()=>{
  fc.assert(fc.property(fc.integer({min:1,max:99999}),fc.integer({min:1,max:50}),(number,ordinal)=>{
    const site={kind:"customer_site",id:"customer",address:"Customer"},yard={kind:"yard",id:"yard",address:"Yard"};
    const input={rentalNumber:number,kind:"exchange",exchangeNumber:ordinal,sequence:"collection_first",reuse:"different_bin",
      binTypeId:"14",deliveryAssetId:"new",collectionAssetId:"old",source:yard,site,
      dumpSite:{kind:"dump_site",id:"dump",address:"Dump"},materialId:"fill",destination:{kind:"yard",location:yard},
      collectionWindow:{startAt:"2026-10-20T12:00:00Z",endAt:"2026-10-20T14:00:00Z"},
      deliveryWindow:{startAt:"2026-10-20T13:00:00Z",endAt:"2026-10-20T15:00:00Z"}};
    const flow=buildBinOrderWorkflow(input),c=flow.parts.find(p=>p.role==="collection");
    assert.equal(c.assetId,"old");
    assert.deepEqual(c.steps.map(s=>s.actionCode),["pickup_bin","dump_bin","return_bin"]);
    assert.deepEqual(flow.dependencies,[{part:"delivery",actionCode:"deliver_bin",requiresPart:"collection",requiresActionCode:"pickup_bin"}]);
    assert.equal(flow.parts.find(p=>p.role==="delivery").assetId,"new");
  }),{numRuns:200,seed:20261021});
});

test("property: a completion can never precede its prerequisite, while a later real completion is retained",()=>{
  fc.assert(fc.property(fc.integer({min:1,max:604800}),(seconds)=>{
    const at=Date.parse("2026-10-20T12:00:00Z");
    assert.throws(()=>assertBinWorkflowDependency({completedAt:new Date(at).toISOString(),
      occurredAt:new Date(at-seconds*1000).toISOString(),sameDay:true}),/before/);
    const result=assertBinWorkflowDependency({completedAt:new Date(at).toISOString(),
      occurredAt:new Date(at+seconds*1000).toISOString(),sameDay:true});
    // These generated dates stay in Toronto daylight time (UTC−4).
    const completedDay=new Date(at-4*3600000).toISOString().slice(0,10);
    const actualDay=new Date(at+seconds*1000-4*3600000).toISOString().slice(0,10);
    assert.equal(result.late,actualDay!==completedDay);
  }),{numRuns:300,seed:20261022});
});
